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
 */
export class JalousieAccessory {
  private service: Service;

  private currentPosition = 0;
  private targetPosition = 0;
  private positionState = 2; // 0 = going to min, 1 = going to max, 2 = stopped
  private updateInterval?: NodeJS.Timeout;

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
      .setCharacteristic(this.platform.Characteristic.Model, 'PLC Jalousie')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, registerPath);

    // Set up name for the accessory
    this.service.setCharacteristic(this.platform.Characteristic.Name, jalousieInfo.name);

    // Register handlers for the Current Position Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.handleCurrentPositionGet.bind(this));

    // Register handlers for the Target Position Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.handleTargetPositionGet.bind(this))
      .onSet(this.handleTargetPositionSet.bind(this));

    // Register handlers for the Position State Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handlePositionStateGet.bind(this));

    // Update position periodically
    const pollingInterval = this.platform.config.pollingInterval || 10;
    this.updateInterval = setInterval(() => {
      this.updateCurrentPosition();
    }, pollingInterval * 1000); // Convert to milliseconds

    // Initial position update
    this.updateCurrentPosition();

    this.log.info(`Jalousie accessory initialized: ${jalousieInfo.name}`);
  }

  /**
   * Clean up resources when the accessory is removed
   */
  public teardown() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.log.info(`Jalousie accessory removed: ${this.jalousieInfo.name}`);
  }

  /**
   * Handle requests to get the current position
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
   */
  handleTargetPositionGet() {
    this.log.debug(`Get Target Position for ${this.jalousieInfo.name}: ${this.targetPosition}%`);
    return this.targetPosition;
  }

  /**
   * Handle requests to set the target position
   */
  async handleTargetPositionSet(value) {
    this.targetPosition = value as number;
    this.log.info(`Set Target Position for ${this.jalousieInfo.name}: ${this.targetPosition}%`);

    try {
      // Determine if we're going up or down
      if (this.targetPosition > this.currentPosition) {
        this.positionState = 1; // Going up
        await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'TRUE');
        await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'FALSE');
        this.log.debug(`${this.jalousieInfo.name} - Moving UP`);
      } else if (this.targetPosition < this.currentPosition) {
        this.positionState = 0; // Going down
        await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'TRUE');
        await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'FALSE');
        this.log.debug(`${this.jalousieInfo.name} - Moving DOWN`);
      } else {
        this.positionState = 2; // Stopped
        await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'FALSE');
        await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'FALSE');
        this.log.debug(`${this.jalousieInfo.name} - Already at target position`);
      }

      // Update the service
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);

      // If we want to step-by-step control for precise positioning
      if (this.jalousieInfo.hasStepControl && Math.abs(this.targetPosition - this.currentPosition) <= 10) {
        // Use step control for precise movements
        await this.sendCommand(`SET:${this.registerPath}.GTSAP1_SHUTTER_ROTUP_CONTROL`,
          this.targetPosition > this.currentPosition ? 'TRUE' : 'FALSE');
        this.log.debug(`${this.jalousieInfo.name} - Using step control for precise positioning`);
      }
    } catch (error) {
      this.log.error(`Error setting position for ${this.jalousieInfo.name}: ${error}`);
    }
  }

  /**
   * Handle requests to get the position state
   */
  handlePositionStateGet() {
    const stateNames = ['DECREASING', 'INCREASING', 'STOPPED'];
    this.log.debug(`Get Position State for ${this.jalousieInfo.name}: ${stateNames[this.positionState]}`);
    return this.positionState;
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
            this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.currentPosition);
          }

          // If we've reached the target position, update state to stopped
          if (this.currentPosition === this.targetPosition && this.positionState !== 2) {
            this.positionState = 2; // Stopped
            this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);

            // Ensure controls are turned off
            await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'FALSE');
            await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'FALSE');
            this.log.debug(`${this.jalousieInfo.name} - Target position reached, stopped at ${this.currentPosition}%`);
          }
        }
      }
    } catch (error) {
      this.log.error(`Error updating position for ${this.jalousieInfo.name}: ${error}`);
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
        this.log.debug(`Sent command: ${fullCommand.trim()}`);
      });

      client.on('data', (data) => {
        responseData += data.toString();
        if (responseData.indexOf('\n') !== -1) {
          client.end();
        }
      });

      client.on('close', () => {
        this.log.debug(`Response for ${command}: ${responseData.trim()}`);
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
