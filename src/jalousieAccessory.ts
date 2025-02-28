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
  upDownTime?: number; // Time in milliseconds for full movement
}

/**
 * JalousieAccessory - represents a single blind/shutter device
 * Implements the HomeKit WindowCovering service
 */
export class JalousieAccessory {
  private service: Service;
  private updateInterval?: NodeJS.Timeout;
  private operationTimeout?: NodeJS.Timeout;

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
  private upDownTime = 0; // Time in milliseconds for full movement
  private lastKnownPosition = 0;

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

    // Initialize and get properties
    this.initialize();

    // Update position periodically
    const pollingInterval = this.platform.config.pollingInterval || 10;
    this.updateInterval = setInterval(() => {
      this.updateCurrentPositionAndState().catch(err => {
        this.log.debug(`Error updating position for ${this.jalousieInfo.name}: ${err}`);
      });
    }, pollingInterval * 1000); // Convert to milliseconds

    this.log.info(`Jalousie accessory initialized: ${jalousieInfo.name}`);
  }

  /**
   * Initialize the accessory by getting properties from PLC
   */
  private async initialize() {
    try {
      // First, get the up-down time if not already provided
      if (!this.jalousieInfo.upDownTime) {
        await this.fetchUpDownTime();
      } else {
        this.upDownTime = this.jalousieInfo.upDownTime;
        this.log.debug(`Using provided upDownTime for ${this.jalousieInfo.name}: ${this.upDownTime}ms`);
      }

      // Then get current position and state
      await this.updateCurrentPositionAndState();
      this.targetPosition = this.currentPosition;
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetPosition,
        this.targetPosition
      );

      this.log.info(`${this.jalousieInfo.name} initialized at position ${this.currentPosition}%, upDownTime: ${this.upDownTime}ms`);
    } catch (err) {
      this.log.error(`Failed to initialize ${this.jalousieInfo.name}: ${err}`);
    }
  }

  /**
   * Fetch the UPDWTIME property from the PLC
   */
  private async fetchUpDownTime() {
    try {
      const response = await this.sendCommand(`GET:${this.registerPath}.UPDWTIME`, '');
      if (response) {
        // Parse response to get up-down time value
        const match = response.match(/GET:.*\.UPDWTIME,(\d+)/);
        if (match && match[1]) {
          this.upDownTime = parseInt(match[1]);
          this.log.info(`Fetched upDownTime for ${this.jalousieInfo.name}: ${this.upDownTime}ms`);
          return this.upDownTime;
        }
      }

      // If we couldn't get the value, use a default
      this.upDownTime = 30000; // Default 30 seconds for full movement
      this.log.warn(`Could not fetch upDownTime for ${this.jalousieInfo.name}, using default: ${this.upDownTime}ms`);
      return this.upDownTime;
    } catch (error) {
      this.log.error(`Error fetching upDownTime for ${this.jalousieInfo.name}: ${error}`);
      // Use default value in case of error
      this.upDownTime = 30000;
      return this.upDownTime;
    }
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
    try {
      await this.updateCurrentPosition();
      this.log.debug(`Get Current Position for ${this.jalousieInfo.name}: ${this.currentPosition}%`);
      return this.currentPosition;
    } catch (error) {
      this.log.error(`Error getting position for ${this.jalousieInfo.name}: ${error}`);
      return this.currentPosition;
    }
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

      // First stop any current movement
      await this.stopMovement();

      // Calculate the movement time based on position difference and upDownTime
      const positionDifference = Math.abs(this.targetPosition - this.currentPosition);
      const movementPercentage = positionDifference / 100;
      const estimatedTime = Math.ceil(this.upDownTime * movementPercentage);

      this.log.debug(`${this.jalousieInfo.name} - Movement calculation: ${positionDifference}% movement, estimated ${estimatedTime}ms`);

      // Determine direction and set position state
      if (this.targetPosition > this.currentPosition) {
        this.positionState = this.POSITION_STATE.INCREASING;
        this.service.updateCharacteristic(
          this.platform.Characteristic.PositionState,
          this.POSITION_STATE.INCREASING
        );

        // Send command to move up - only send one command
        const response = await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'TRUE');
        if (!response.includes("DIFF:") && !response.includes(",1")) {
          throw new Error(`Failed to start up movement, response: ${response}`);
        }
        this.log.debug(`${this.jalousieInfo.name} - Moving UP for ${estimatedTime}ms`);
      } else {
        this.positionState = this.POSITION_STATE.DECREASING;
        this.service.updateCharacteristic(
          this.platform.Characteristic.PositionState,
          this.POSITION_STATE.DECREASING
        );

        // Send command to move down - only send one command
        const response = await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'TRUE');
        if (!response.includes("DIFF:") && !response.includes(",1")) {
          throw new Error(`Failed to start down movement, response: ${response}`);
        }
        this.log.debug(`${this.jalousieInfo.name} - Moving DOWN for ${estimatedTime}ms`);
      }

      this.moving = true;

      // Set a timeout to stop the movement after the calculated time
      this.operationTimeout = setTimeout(async () => {
        this.log.debug(`${this.jalousieInfo.name} - Timed movement complete, stopping`);
        await this.stopMovement();

        // Update position after movement
        await this.updateCurrentPositionAndState();
      }, estimatedTime);
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
  async handlePositionStateGet() {
    try {
      // Get the latest state before returning
      await this.updateMovementState();

      const stateNames = ['DECREASING', 'INCREASING', 'STOPPED'];
      this.log.debug(`Get Position State for ${this.jalousieInfo.name}: ${stateNames[this.positionState]}`);
      return this.positionState;
    } catch (error) {
      this.log.error(`Error getting position state: ${error}`);
      return this.positionState;
    }
  }

  /**
   * Handle requests to hold current position (stop movement)
   */
  async handleHoldPositionSet(value) {
    if (value) {
      this.log.info(`Hold position requested for ${this.jalousieInfo.name}`);

      // Cancel any operation timeout
      if (this.operationTimeout) {
        clearTimeout(this.operationTimeout);
        this.operationTimeout = undefined;
      }

      await this.stopMovement();

      // Update current position and state
      await this.updateCurrentPositionAndState();
    }
  }

  /**
   * Stop jalousie movement and update state
   */
  private async stopMovement() {
    try {
      let response;
      // If we were increasing, we need to set WEBUP to FALSE
      if (this.positionState === this.POSITION_STATE.INCREASING) {
        response = await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'FALSE');
        if (!response.includes("DIFF:") && !response.includes(",0")) {
          this.log.warn(`Unexpected response when stopping up movement: ${response}`);
        }
      }
      // If we were decreasing, we need to set WEBDW to FALSE
      else if (this.positionState === this.POSITION_STATE.DECREASING) {
        response = await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'FALSE');
        if (!response.includes("DIFF:") && !response.includes(",0")) {
          this.log.warn(`Unexpected response when stopping down movement: ${response}`);
        }
      }

      // Update state
      this.moving = false;
      this.positionState = this.POSITION_STATE.STOPPED;

      // Update HomeKit characteristics
      this.service.updateCharacteristic(
        this.platform.Characteristic.PositionState,
        this.POSITION_STATE.STOPPED
      );

      // Get current position after stopping
      await this.updateCurrentPosition();

      // Update target to current position if we're at a stable state
      this.targetPosition = this.currentPosition;
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetPosition,
        this.targetPosition
      );

      this.log.debug(`${this.jalousieInfo.name} - Movement stopped at position ${this.currentPosition}%`);
    } catch (error) {
      this.log.error(`Error stopping movement for ${this.jalousieInfo.name}: ${error}`);
    }
  }

  // This method is no longer needed as we're using a timeout based on UPDWTIME

  /**
   * Update both the current position and movement state from the PLC
   */
  async updateCurrentPositionAndState() {
    try {
      // First get the position
      await this.updateCurrentPosition();

      // Then check the movement state
      await this.updateMovementState();

      return {
        position: this.currentPosition,
        state: this.positionState
      };
    } catch (error) {
      this.log.error(`Error updating state for ${this.jalousieInfo.name}: ${error}`);
      throw error;
    }
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
   * Update the movement state from the PLC using GTSAP1_SHUTTER properties
   */
  async updateMovementState() {
    try {
      // Check if running using GTSAP1_SHUTTER_run
      const runResponse = await this.sendCommand(`GET:${this.registerPath}.GTSAP1_SHUTTER_run`, '');
      const isRunning = runResponse.includes(',1') || runResponse.includes(',TRUE');

      // If not running, set to stopped
      if (!isRunning) {
        if (this.positionState !== this.POSITION_STATE.STOPPED) {
          this.log.debug(`${this.jalousieInfo.name} - Movement detected as STOPPED`);
          this.positionState = this.POSITION_STATE.STOPPED;
          this.moving = false;
          this.service.updateCharacteristic(
            this.platform.Characteristic.PositionState,
            this.POSITION_STATE.STOPPED
          );

          // If we reached a position close to target, update target to match current
          if (Math.abs(this.currentPosition - this.targetPosition) <= 5) {
            this.targetPosition = this.currentPosition;
            this.service.updateCharacteristic(
              this.platform.Characteristic.TargetPosition,
              this.targetPosition
            );
          }
        }
        return this.positionState;
      }

      // If running, check direction
      const upResponse = await this.sendCommand(`GET:${this.registerPath}.GTSAP1_SHUTTER_up`, '');
      const isMovingUp = upResponse.includes(',1') || upResponse.includes(',TRUE');

      if (isMovingUp) {
        if (this.positionState !== this.POSITION_STATE.INCREASING) {
          this.log.debug(`${this.jalousieInfo.name} - Movement detected as UP`);
          this.positionState = this.POSITION_STATE.INCREASING;
          this.moving = true;
          this.service.updateCharacteristic(
            this.platform.Characteristic.PositionState,
            this.POSITION_STATE.INCREASING
          );
        }
      } else {
        // Must be moving down
        if (this.positionState !== this.POSITION_STATE.DECREASING) {
          this.log.debug(`${this.jalousieInfo.name} - Movement detected as DOWN`);
          this.positionState = this.POSITION_STATE.DECREASING;
          this.moving = true;
          this.service.updateCharacteristic(
            this.platform.Characteristic.PositionState,
            this.POSITION_STATE.DECREASING
          );
        }
      }

      return this.positionState;
    } catch (error) {
      this.log.error(`Error updating movement state for ${this.jalousieInfo.name}: ${error}`);
      return this.positionState;
    }
  }

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
