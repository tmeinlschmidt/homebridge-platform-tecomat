import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import * as net from 'net';

/**
 * JalousieAccessory - represents a single blind/shutter device
 */
class JalousieAccessory {
  private service: Service;
  private client: net.Socket;

  private currentPosition = 0;
  private targetPosition = 0;
  private positionState = 2; // 0 = going to min, 1 = going to max, 2 = stopped

  constructor(
    private readonly platform: PlcJalousiePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly registerPath: string,
    private readonly jalousieInfo: JalousieInfo,
  ) {
    this.client = new net.Socket();

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
    setInterval(() => {
      this.updateCurrentPosition();
    }, 10000); // Update every 10 seconds
  }

  /**
   * Handle requests to get the current position
   */
  async handleCurrentPositionGet() {
    await this.updateCurrentPosition();
    this.platform.log.debug('Get Current Position:', this.currentPosition);
    return this.currentPosition;
  }

  /**
   * Handle requests to get the target position
   */
  handleTargetPositionGet() {
    this.platform.log.debug('Get Target Position:', this.targetPosition);
    return this.targetPosition;
  }

  /**
   * Handle requests to set the target position
   */
  async handleTargetPositionSet(value) {
    this.targetPosition = value as number;
    this.platform.log.debug('Set Target Position:', value);

    // Determine if we're going up or down
    if (this.targetPosition > this.currentPosition) {
      this.positionState = 1; // Going up
      await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'TRUE');
      await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'FALSE');
    } else if (this.targetPosition < this.currentPosition) {
      this.positionState = 0; // Going down
      await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'TRUE');
      await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'FALSE');
    } else {
      this.positionState = 2; // Stopped
      await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'FALSE');
      await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'FALSE');
    }

    // Update the service
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);

    // If we want to step-by-step control for precise positioning
    if (this.jalousieInfo.hasStepControl && Math.abs(this.targetPosition - this.currentPosition) <= 10) {
      // Use step control for precise movements
      await this.sendCommand(`SET:${this.registerPath}.GTSAP1_SHUTTER_ROTUP_CONTROL`,
        this.targetPosition > this.currentPosition ? 'TRUE' : 'FALSE');
    }
  }

  /**
   * Handle requests to get the position state
   */
  handlePositionStateGet() {
    this.platform.log.debug('Get Position State:', this.positionState);
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
          this.currentPosition = parseInt(match[1]);

          // If we've reached the target position, update state to stopped
          if (this.currentPosition === this.targetPosition) {
            this.positionState = 2; // Stopped
            this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);

            // Ensure controls are turned off
            await this.sendCommand(`SET:${this.registerPath}.WEBUP`, 'FALSE');
            await this.sendCommand(`SET:${this.registerPath}.WEBDW`, 'FALSE');
          }

          // Update HomeKit
          this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.currentPosition);
        }
      }
    } catch (error) {
      this.platform.log.error('Error updating position:', error);
    }
  }

  /**
   * Send a command to the PLC and get the response
   */
  async sendCommand(command: string, value: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let responseData = '';

      client.connect(this.platform.config.port, this.platform.config.ipAddress, () => {
        this.platform.log.debug(`Connected to PLC for command: ${command}`);
        if (value) {
          client.write(`${command},${value}\n`);
        } else {
          client.write(`${command}\n`);
        }
      });

      client.on('data', (data) => {
        responseData += data.toString();
        if (responseData.indexOf('\n') !== -1) {
          client.end();
        }
      });

      client.on('close', () => {
        this.platform.log.debug(`Response for ${command}: ${responseData.trim()}`);
        resolve(responseData.trim());
      });

      client.on('error', (err) => {
        this.platform.log.error(`Error for command ${command}: ${err.message}`);
        reject(err);
      });

      // Set timeout
      setTimeout(() => {
        if (client.writable) {
          client.end();
          reject(new Error('Command timeout'));
        }
      }, 5000);
    });
  }
}

/**
 * Interface for jalousie information
 */
interface JalousieInfo {
  name: string;
  blockPath: string;
  hasStepControl: boolean;
}

/**
 * PLC Jalousie Platform
 */
export class PlcJalousiePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * Send a command to the PLC and wait for response
   */
  private async sendPlcCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let responseData = '';

      client.connect(this.config.port, this.config.ipAddress, () => {
        this.log.debug(`Connected to PLC for command: ${command}`);
        client.write(`${command}\n`);
      });

      client.on('data', (data) => {
        responseData += data.toString();
        if (responseData.includes('\n')) {
          client.end();
        }
      });

      client.on('close', () => {
        this.log.debug(`Command completed: ${command}, response length: ${responseData.length}`);
        resolve(responseData);
      });

      client.on('error', (err) => {
        this.log.error(`Error for command ${command}: ${err.message}`);
        reject(err);
      });

      // Set timeout
      setTimeout(() => {
        if (client.writable) {
          client.end();
          reject(new Error('Command timeout'));
        }
      }, 10000); // 10 second timeout for initial discovery
    });
  }

  /**
   * Parse LIST response to find jalousie blocks
   */
  private parseJalousieBlocks(listResponse: string): string[] {
    const lines = listResponse.split('\n');
    const jalousieBlocks = new Set<string>();

    for (const line of lines) {
      // Check if this is a jalousie control block
      if (line.includes('.CJALOUSIE.')) {
        // Extract the base path of the jalousie block
        const match = line.match(/LIST:(.*?)\.CJALOUSIE\./);
        if (match && match[1]) {
          jalousieBlocks.add(match[1] + '.CJALOUSIE');
        }
      }
    }

    return Array.from(jalousieBlocks);
  }

  /**
   * Get jalousie name from the PLC
   */
  private async getJalousieName(blockPath: string): Promise<string> {
    try {
      const response = await this.sendPlcCommand(`GET:${blockPath}.JALOUSIENAME`);
      const match = response.match(/GET:.*JALOUSIENAME,"(.*)"/);
      if (match && match[1]) {
        return match[1];
      } else {
        // Try alternate method - some systems use NAME instead of JALOUSIENAME
        const altResponse = await this.sendPlcCommand(`GET:${blockPath}.NAME`);
        const altMatch = altResponse.match(/GET:.*NAME,"(.*)"/);
        if (altMatch && altMatch[1]) {
          return altMatch[1];
        }
      }
      return blockPath.split('.').pop() || 'Unknown Jalousie';
    } catch (error) {
      this.log.error(`Error getting jalousie name for ${blockPath}:`, error);
      return blockPath.split('.').pop() || 'Unknown Jalousie';
    }
  }

  /**
   * Check if the jalousie block has step control
   */
  private hasStepControl(listResponse: string, blockPath: string): boolean {
    return listResponse.includes(`${blockPath}.GTSAP1_SHUTTER_ROTUP_CONTROL`);
  }

  /**
   * Discover jalousie devices from PLC
   */
  async discoverDevices() {
    try {
      this.log.info('Discovering jalousie devices...');
      this.log.info(`Connecting to PLC at ${this.config.ipAddress}:${this.config.port}`);

      // Send LIST command to get all registers
      const listResponse = await this.sendPlcCommand('LIST:');
      this.log.debug(`Received LIST response with ${listResponse.length} characters`);

      // Parse the response to find jalousie blocks
      const jalousieBlocks = this.parseJalousieBlocks(listResponse);
      this.log.info(`Found ${jalousieBlocks.length} jalousie blocks`);

      // Process each jalousie block
      for (const blockPath of jalousieBlocks) {
        try {
          // Get the name of this jalousie
          const name = await this.getJalousieName(blockPath);
          this.log.info(`Found jalousie: ${name} at path ${blockPath}`);

          // Check if this jalousie has step control
          const hasStepControl = this.hasStepControl(listResponse, blockPath);

          // Create jalousie info object
          const jalousieInfo: JalousieInfo = {
            name,
            blockPath,
            hasStepControl,
          };

          // Generate a unique id for this jalousie
          const uuid = this.api.hap.uuid.generate(blockPath);

          // Check if an accessory with the same uuid has already been registered and restored from
          // the cached devices we stored in the `configureAccessory` method above
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

          if (existingAccessory) {
            // Restore existing accessory
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

            // Update accessory context
            existingAccessory.context.jalousieInfo = jalousieInfo;

            // Create the accessory handler
            new JalousieAccessory(this, existingAccessory, blockPath, jalousieInfo);

            // Update accessory display name
            existingAccessory.displayName = name;
          } else {
            // Create a new accessory
            this.log.info('Adding new accessory:', name);

            // Create the accessory
            const accessory = new this.api.platformAccessory(name, uuid);

            // Store jalousie info in the accessory context
            accessory.context.jalousieInfo = jalousieInfo;

            // Create the accessory handler
            new JalousieAccessory(this, accessory, blockPath, jalousieInfo);

            // Register the accessory
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
        } catch (error) {
          this.log.error(`Error processing jalousie block ${blockPath}:`, error);
        }
      }
    } catch (error) {
      this.log.error('Error discovering devices:', error);
    }
  }
}
