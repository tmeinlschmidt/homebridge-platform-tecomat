import { PlatformAccessory, Service, Logger } from 'homebridge';
import { PlcJalousiePlatform } from './platform';
import * as net from 'net';

/**
 * Interface for jalousie information
 */
export interface JalousieInfo {
  name: string;
  blockPath: string;
  hasStepControl: boolean;
}

/**
 * JalousieAccessory - represents a single blind/shutter device
 * Implements the HomeKit WindowCovering service
 */
export class JalousieAccessory {
  private service: Service;
  private updateInterval?: NodeJS.Timeout;

  // Homebridge characteristics
  private readonly POSITION_STATE = {
    DECREASING: 0,
    INCREASING: 1,
    STOPPED: 2
  };

  // State variables
  private currentPosition = 100;  // HomeKit: 0 (fully closed) to 100 (fully open)
  private targetPosition = 100;   // HomeKit: 0 (fully closed) to 100 (fully open)
  private positionState = this.POSITION_STATE.STOPPED;
  private moving = false;
  private lastCommandTime = 0;
  private operationTimeout?: NodeJS.Timeout;

  constructor(
    private readonly platform: PlcJalousiePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly registerPath: string,
    private readonly jalousieInfo: JalousieInfo,
    private readonly log: Logger,
  ) {
    // Setup window covering service
    this.service = this.accessory.getService(this.platform.Service.WindowCovering)
      || this.accessory.addService(this.platform.Service.WindowCovering);

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'PLC Jalousie')
      .setCharacteristic(this.platform.Characteristic.Model, 'PLC Jalousie Controller')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.registerPath);

    // Set up name for the accessory
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.jalousieInfo.name);

    // Register handlers for the Required Characteristics

    // 1. Current Position (Required)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.handleCurrentPositionGet.bind(this));

    // 2. Target Position (Required)
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.handleTargetPositionGet.bind(this))
      .onSet(this.handleTargetPositionSet.bind(this));

    // 3. Position State (Required)
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handlePositionStateGet.bind(this));

    // 4. Hold Position (Optional) - useful for stopping the jalousie mid-movement
    this.service.getCharacteristic(this.platform.Characteristic.HoldPosition)
      .onSet(this.handleHoldPositionSet.bind(this));

    // Get initial position
    this.updateCurrentPosition()
      .then(() => {
        this.targetPosition = this.currentPosition;
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetPosition,
          this.targetPosition
        );
      })
      .catch(err => {
        this.log.error(`Failed to get initial position for ${this.jalousieInfo.name}: ${err}`);
      });

    // Update position periodically
    const pollingInterval = this.platform.config.pollingInterval || 10;
    this.updateInterval = setInterval(() => {
      this.updateCurrentPosition().catch(err => {
        this.log.debug(`Error updating position for ${this.jalousieInfo.name}: ${err}`);
      });
    }, pollingInterval * 1000); // Convert to milliseconds

    this.log.info(`Jalousie accessory initialized: ${jalousieInfo.name}`);
  }

  /**
   * Clean up resources when the accessory is removed
   */
  public teardown() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    if (this.operationTimeout) {
      clearTimeout(this.operationTimeout);
    }
    this.log.info(`Jalousie accessory removed: ${this.jalousieInfo.name}`);
  }

  /**
   * Handle requests to get the current position
   * @returns current position (0-100)
   */
  async handleCurrentPositionGet() {
    this.log.debug(`Get Current Position for ${this.jalousieInfo.name}: ${this.currentPosition}%`);
    return this.currentPosition;
  }

  /**
   * Handle requests to get the target position
   * @returns target position (0-100)
   */
  handleTargetPositionGet() {
    this.log.debug(`Get Target Position for ${this.jalousieInfo.name}: ${this.targetPosition}%`);
    return this.targetPosition;
  }

  /**
   * Handle requests to set the target position
   * @param value target position (0-100)
   */
  async handleTargetPositionSet(value) {
    const newTargetPosition = value as number;

    // If the target position hasn't changed, do nothing
    if (newTargetPosition === this.targetPosition) {
      return;
    }

    this.targetPosition = newTargetPosition;
    this.log.info(`Set Target Position for ${this.jalousieInfo.name}: ${this.targetPosition}%`);

    try {
      // Cancel any existing operation timeout
      if (this.operationTimeout) {
        clearTimeout(this.operationTimeout);
      }

      // Determine direction and set position state
      if (this.targetPosition > this.currentPosition) {
        this.positionState = this.POSITION_STATE.INCREASING;
        this.service.updateCharacteristic(
          this.platform.Characteristic.PositionState,
          this.POSITION_STATE.INCREASING
        );

        // Send command to move up - only set TRUE to move
        await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'TRUE');
        this.log.debug(`${this.jalousieInfo.name} - Moving UP`);
      } else {
        this.positionState = this.POSITION_STATE.DECREASING;
        this.service.updateCharacteristic(
          this.platform.Characteristic.PositionState,
          this.POSITION_STATE.DECREASING
        );

        // Send command to move down - only set TRUE to move
        await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'TRUE');
        this.log.debug(`${this.jalousieInfo.name} - Moving DOWN`);
      }

      this.moving = true;
      this.lastCommandTime = Date.now();

      // Set a timeout to stop the operation after a reasonable time
      // Calculate estimated time based on distance to move
      const positionDifference = Math.abs(this.targetPosition - this.currentPosition);
      const estimatedTime = Math.max(5000, positionDifference * 300); // 300ms per 1% movement, minimum 5 seconds

      this.operationTimeout = setTimeout(() => {
        // Force stop if we seem to be taking too long
        if (this.moving) {
          this.log.debug(`Operation timeout for ${this.jalousieInfo.name}, stopping movement`);
          this.stopMovement().catch(err => {
            this.log.error(`Error stopping movement for ${this.jalousieInfo.name}: ${err}`);
          });
        }
      }, estimatedTime);

      // Update more frequently during movement
      this.increasePollRateDuringMovement();
    } catch (error) {
      this.log.error(`Error setting position for ${this.jalousieInfo.name}: ${error}`);
      // Reset to stopped state on error
      this.positionState = this.POSITION_STATE.STOPPED;
      this.service.updateCharacteristic(
        this.platform.Characteristic.PositionState,
        this.POSITION_STATE.STOPPED
      );
      this.moving = false;
    }
  }

  /**
   * Handle requests to get the position state
   * @returns position state (0=DECREASING, 1=INCREASING, 2=STOPPED)
   */
  handlePositionStateGet() {
    const stateNames = ['DECREASING', 'INCREASING', 'STOPPED'];
    this.log.debug(`Get Position State for ${this.jalousieInfo.name}: ${stateNames[this.positionState]}`);
    return this.positionState;
  }

  /**
   * Handle requests to hold current position (stop movement)
   */
  async handleHoldPositionSet(value) {
    if (value) {
      this.log.info(`Hold position requested for ${this.jalousieInfo.name}`);
      await this.stopMovement();
    }
  }

  /**
   * Stop jalousie movement and update state
   */
  private async stopMovement() {
    try {
      // If we were increasing, we only need to set WEBUP to FALSE
      if (this.positionState === this.POSITION_STATE.INCREASING) {
        await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'FALSE');
      }
      // If we were decreasing, we only need to set WEBDW to FALSE
      else if (this.positionState === this.POSITION_STATE.DECREASING) {
        await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'FALSE');
      }

      // Update state
      this.moving = false;
      this.positionState = this.POSITION_STATE.STOPPED;

      // Update target position to current position
      await this.updateCurrentPosition();
      this.targetPosition = this.currentPosition;

      // Update HomeKit characteristics
      this.service.updateCharacteristic(
        this.platform.Characteristic.PositionState,
        this.POSITION_STATE.STOPPED
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetPosition,
        this.targetPosition
      );

      this.log.debug(`${this.jalousieInfo.name} - Movement stopped`);
    } catch (error) {
      this.log.error(`Error stopping movement for ${this.jalousieInfo.name}: ${error}`);
    }
  }

  /**
   * Increase polling rate temporarily during movement
   */
  private increasePollRateDuringMovement() {
    const quickUpdateInterval = 1000; // 1 second during movement
    const pollCount = 30; // Poll more frequently for 30 seconds
    let count = 0;

    const quickPoll = setInterval(async () => {
      try {
        await this.updateCurrentPosition();
        count++;

        // If we've reached target position or exceeded poll count, stop quick polling
        if (!this.moving || this.currentPosition === this.targetPosition || count >= pollCount) {
          clearInterval(quickPoll);
        }
      } catch (error) {
        this.log.debug(`Error during quick polling for ${this.jalousieInfo.name}: ${error}`);
        clearInterval(quickPoll);
      }
    }, quickUpdateInterval);
  }

  /**
   * Update the current position from the PLC
   */
  async updateCurrentPosition() {
    try {
      const positionResponse = await this.sendCommand(`GET:${this.registerPath}.POSIT`, '');
      if (positionResponse) {
        // Parse response to get position value
        const match = positionResponse.match(/GET:.*\.POSIT,(\d+)/);
        if (match && match[1]) {
          const newPosition = parseInt(match[1]);

          // Only update and log if the position has changed
          if (newPosition !== this.currentPosition) {
            this.log.debug(`Position update for ${this.jalousieInfo.name}: ${newPosition}%`);
            this.currentPosition = newPosition;

            // Update HomeKit
            this.service.updateCharacteristic(
              this.platform.Characteristic.CurrentPosition,
              this.currentPosition
            );

            // Check if we are moving and need to handle reaching target position
            this.handlePositionUpdate();
          }

          return this.currentPosition;
        }
      }
      return this.currentPosition;
    } catch (error) {
      this.log.error(`Error updating position for ${this.jalousieInfo.name}: ${error}`);
      throw error;
    }
  }

  /**
   * Handle position updates and state transitions
   */
  private async handlePositionUpdate() {
    // If not currently marked as moving, don't do anything
    if (!this.moving) {
      return;
    }

    // Check if we've reached the target position (or passed it)
    if ((this.positionState === this.POSITION_STATE.INCREASING && this.currentPosition >= this.targetPosition) ||
        (this.positionState === this.POSITION_STATE.DECREASING && this.currentPosition <= this.targetPosition) ||
        this.currentPosition === this.targetPosition) {

      // Stop the movement
      await this.stopMovement();
      return;
    }

    // Check if we should be moving but position hasn't changed in a while
    const timeElapsed = Date.now() - this.lastCommandTime;
    if (timeElapsed > 10000) { // 10 seconds with no movement
      const hasPositionChanged =
        (this.positionState === this.POSITION_STATE.INCREASING && this.currentPosition > this.lastKnownPosition) ||
        (this.positionState === this.POSITION_STATE.DECREASING && this.currentPosition < this.lastKnownPosition);

      if (!hasPositionChanged) {
        this.log.debug(`No movement detected for ${this.jalousieInfo.name} after 10 seconds, stopping`);
        await this.stopMovement();
      } else {
        // Reset timer as movement is happening
        this.lastCommandTime = Date.now();
        this.lastKnownPosition = this.currentPosition;
      }
    }
  }

  // Track the last known position for movement detection
  private lastKnownPosition = 0;

  /**
   * Send a command to the PLC and get the response
   */
  private async sendCommand(command: string, value: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let responseData = '';
      const commandTimeout = this.platform.config.commandTimeout || 5000;

      client.connect(this.platform.config.port, this.platform.config.ipAddress, () => {
        const fullCommand = value ? `${command},${value}\n` : `${command}\n`;
        client.write(fullCommand);
        if (this.platform.config.debug) {
          this.log.debug(`Sent command: ${fullCommand.trim()}`);
        }
      });

      client.on('data', (data) => {
        responseData += data.toString();
        if (responseData.indexOf('\n') !== -1) {
          client.end();
        }
      });

      client.on('close', () => {
        if (this.platform.config.debug) {
          this.log.debug(`Response for ${command}: ${responseData.trim()}`);
        }
        resolve(responseData.trim());
      });

      client.on('error', (err) => {
        this.log.error(`Error for command ${command}: ${err.message}`);
        reject(err);
      });

      // Set timeout
      setTimeout(() => {
        if (client.writable) {
          client.end();
          reject(new Error(`Command timeout after ${commandTimeout}ms: ${command}`));
        }
      }, commandTimeout);
    });
  }
}
