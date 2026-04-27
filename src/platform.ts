import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { JalousieAccessory, JalousieInfo } from './jalousieAccessory';
import {
  parseJalousieBlocks,
  parseQuotedProperty,
  parseUpDownTime,
} from './jalousieLogic';
import * as net from 'net';

/**
 * PLC Jalousie Platform
 */
export class PlcJalousiePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  // map to track jalousie accessory instances
  private readonly jalousieAccessories: Map<string, JalousieAccessory> = new Map();

  private discoveryInterval?: NodeJS.Timeout;

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

      // Run initial device discovery
      this.discoverDevices();

      // Set up periodic rediscovery if enabled
      const autoDiscoveryInterval = this.config.autoDiscoveryInterval as number;
      if (autoDiscoveryInterval && autoDiscoveryInterval > 0) {
        this.log.info(`Setting up automatic device rediscovery every ${autoDiscoveryInterval} minutes`);
        this.discoveryInterval = setInterval(() => {
          this.log.info('Running scheduled device rediscovery...');
          this.discoverDevices();
        }, autoDiscoveryInterval * 60 * 1000); // Convert minutes to milliseconds
      }
    });

    // Clean up on shutdown
    this.api.on('shutdown', () => {
      if (this.discoveryInterval) {
        clearInterval(this.discoveryInterval);
      }

      // Clean up all accessories
      for (const accessory of this.jalousieAccessories.values()) {
        accessory.teardown();
      }

      this.log.info('Platform shutdown');
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
      let settled = false;
      const discoveryTimeout = this.config.discoveryTimeout || 15000;
      const debug = this.config.debug || false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        client.destroy();
        reject(new Error(`Discovery command timeout after ${discoveryTimeout}ms: ${command}`));
      }, discoveryTimeout);

      const settle = (kind: 'resolve' | 'reject', payload: string | Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (kind === 'resolve') {
          resolve(payload as string);
        } else {
          reject(payload as Error);
        }
      };

      client.connect(this.config.port, this.config.ipAddress, () => {
        if (debug) {
          this.log.debug(`Connected to PLC for command: ${command}`);
        }
        client.write(`${command}\n`);
      });

      client.on('data', (data) => {
        responseData += data.toString();
        if (responseData.includes('\n')) {
          client.end();
        }
      });

      client.on('close', () => {
        if (debug) {
          this.log.debug(`Command completed: ${command}, response length: ${responseData.length}`);
        }
        settle('resolve', responseData);
      });

      client.on('error', (err) => {
        this.log.error(`Error for command ${command}: ${err.message}`);
        settle('reject', err);
      });
    });
  }

  /**
   * Get jalousie name from the PLC
   */
  private async getJalousieName(blockPath: string): Promise<string> {
    try {
      const response = await this.sendPlcCommand(`GET:${blockPath}.JALOUSIENAME`);
      const name = parseQuotedProperty(response, 'JALOUSIENAME');
      if (name) {
        return name;
      }
      // Try alternate method - some systems use NAME instead of JALOUSIENAME
      const altResponse = await this.sendPlcCommand(`GET:${blockPath}.NAME`);
      const altName = parseQuotedProperty(altResponse, 'NAME');
      if (altName) {
        return altName;
      }
      return blockPath.split('.').pop() || 'Unknown Jalousie';
    } catch (error) {
      this.log.error(`Error getting jalousie name for ${blockPath}:`, error);
      return blockPath.split('.').pop() || 'Unknown Jalousie';
    }
  }

  /**
   * Check if the jalousie block has step control and other required properties
   */
  private hasRequiredProperties(listResponse: string, blockPath: string): {
    hasStepControl: boolean;
    hasRunProperty: boolean;
    hasUpProperty: boolean;
    hasDownProperty: boolean;
  } {
    return {
      hasStepControl: listResponse.includes(`${blockPath}.GTSAP1_SHUTTER_ROTUP_CONTROL`),
      hasRunProperty: listResponse.includes(`${blockPath}.GTSAP1_SHUTTER_run`),
      hasUpProperty: listResponse.includes(`${blockPath}.GTSAP1_SHUTTER_up`),
      hasDownProperty: listResponse.includes(`${blockPath}.GTSAP1_SHUTTER_down`),
    };
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
      const jalousieBlocks = parseJalousieBlocks(listResponse);
      this.log.info(`Found ${jalousieBlocks.length} jalousie blocks`);

      // Keep track of discovered devices to remove stale ones
      const activeAccessories = new Set<string>();

      // Process each jalousie block
      for (const blockPath of jalousieBlocks) {
        try {
          // Get the name of this jalousie
          const name = await this.getJalousieName(blockPath);
          this.log.info(`Found jalousie: ${name} at path ${blockPath}`);

          // Check if this jalousie has required properties
          const properties = this.hasRequiredProperties(listResponse, blockPath);

          // Fetch the up-down time for this jalousie
          let upDownTime: number | undefined;
          try {
            const response = await this.sendPlcCommand(`GET:${blockPath}.UPDWTIME`);
            const parsed = parseUpDownTime(response);
            if (parsed !== null) {
              upDownTime = parsed;
              this.log.info(`Jalousie ${name} has upDownTime: ${upDownTime}ms`);
            }
          } catch (error) {
            this.log.warn(`Could not get UPDWTIME for ${name}: ${error}`);
          }

          // Create jalousie info object
          const jalousieInfo: JalousieInfo = {
            name,
            blockPath,
            hasStepControl: properties.hasStepControl,
            upDownTime,
          };

          // Generate a unique id for this jalousie
          const uuid = this.api.hap.uuid.generate(blockPath);
          activeAccessories.add(uuid);

          // Check if an accessory with the same uuid has already been registered and restored from
          // the cached devices we stored in the `configureAccessory` method above
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

          if (existingAccessory) {
            // Restore existing accessory
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

            // Clean up any existing accessory instance
            const existingInstance = this.jalousieAccessories.get(uuid);
            if (existingInstance) {
              existingInstance.teardown();
            }

            // Update accessory context
            existingAccessory.context.jalousieInfo = jalousieInfo;
            existingAccessory.displayName = name;

            // Create the accessory handler
            const jalousieAccessory = new JalousieAccessory(this, existingAccessory, blockPath, jalousieInfo, this.log);
            this.jalousieAccessories.set(uuid, jalousieAccessory);
          } else {
            // Create a new accessory
            this.log.info('Adding new accessory:', name);

            // Create the accessory
            const accessory = new this.api.platformAccessory(name, uuid);

            // Store jalousie info in the accessory context
            accessory.context.jalousieInfo = jalousieInfo;

            // Create the accessory handler
            const jalousieAccessory = new JalousieAccessory(this, accessory, blockPath, jalousieInfo, this.log);
            this.jalousieAccessories.set(uuid, jalousieAccessory);

            // Register the accessory
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
        } catch (error) {
          this.log.error(`Error processing jalousie block ${blockPath}:`, error);
        }
      }

      // Remove accessories that no longer exist
      this.accessories.forEach(accessory => {
        const uuid = accessory.UUID;
        if (!activeAccessories.has(uuid)) {
          this.log.info('Removing accessory no longer present:', accessory.displayName);

          // Clean up accessory instance
          const instance = this.jalousieAccessories.get(uuid);
          if (instance) {
            instance.teardown();
            this.jalousieAccessories.delete(uuid);
          }

          // Unregister the accessory
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      });

      this.log.info('Device discovery completed');
    } catch (error) {
      this.log.error('Error discovering devices:', error);
    }
  }
}
