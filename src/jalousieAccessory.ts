import { CharacteristicValue, PlatformAccessory, Service, Logger } from 'homebridge';
import { PlcJalousiePlatform } from './platform';
import * as net from 'net';
import {
  POSITION_STATE,
  calculateMovementTimeMs,
  homekitToPlcPosition,
  isFlagTrue,
  parsePosit,
  parseUpDownTime,
} from './jalousieLogic';

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
 * Transport callable used to talk to the PLC. Returns the raw response
 * string. Pass a custom transport to JalousieAccessory in unit tests.
 */
export type JalousieTransport = (command: string, value: string) => Promise<string>;

/**
 * Optional dependency overrides. Production code leaves these defaulted;
 * tests can inject a fake transport and skip the polling/init lifecycle.
 */
export interface JalousieAccessoryOptions {
  transport?: JalousieTransport;
  /** When true, skip the constructor-time initialize() and polling timer. */
  autoStart?: boolean;
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
  private readonly POSITION_STATE = POSITION_STATE;

  // State variables
  private currentPosition = 100;  // HomeKit: 0 (fully closed) to 100 (fully open)
  private targetPosition = 100;   // HomeKit: 0 (fully closed) to 100 (fully open)
  private positionState: number = this.POSITION_STATE.STOPPED;
  private moving = false;
  private upDownTime = 0; // Time in milliseconds for full movement

  private readonly transport: JalousieTransport;

  constructor(
    private readonly platform: PlcJalousiePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly registerPath: string,
    private readonly jalousieInfo: JalousieInfo,
    private readonly log: Logger,
    options: JalousieAccessoryOptions = {},
  ) {
    this.transport = options.transport ?? this.defaultTransport.bind(this);
    const autoStart = options.autoStart !== false;
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

    if (autoStart) {
      // Initialize and get properties
      this.initialize();

      // Update position periodically
      const pollingInterval = this.platform.config.pollingInterval || 10;
      this.updateInterval = setInterval(() => {
        this.updateCurrentPositionAndState().catch(err => {
          this.log.debug(`Error updating position for ${this.jalousieInfo.name}: ${err}`);
        });
      }, pollingInterval * 1000); // Convert to milliseconds
    }

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
        this.targetPosition,
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
      const response = await this.transport(`GET:${this.registerPath}.UPDWTIME`, '');
      const parsed = parseUpDownTime(response);
      if (parsed !== null) {
        this.upDownTime = parsed;
        this.log.info(`Fetched upDownTime for ${this.jalousieInfo.name}: ${this.upDownTime}ms`);
        return this.upDownTime;
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
  async handleTargetPositionSet(value: CharacteristicValue) {
    const newTargetPosition = value as number;

    // If the target position hasn't changed, do nothing
    if (newTargetPosition === this.targetPosition) {
      return;
    }

    this.targetPosition = newTargetPosition;

    // Convert HomeKit position to PLC position (invert the value)
    // HomeKit: 0 = closed, 100 = open
    // PLC: 100 = closed, 0 = open
    const plcTargetPosition = homekitToPlcPosition(this.targetPosition);

    this.log.info(`Set Target Position for ${this.jalousieInfo.name}: ${this.targetPosition}% (PLC target: ${plcTargetPosition})`);

    try {
      // Cancel any existing operation timeout
      if (this.operationTimeout) {
        clearTimeout(this.operationTimeout);
      }

      // First stop any current movement
      await this.stopMovement();

      // Get current PLC position (inverted from HomeKit)
      const plcCurrentPosition = homekitToPlcPosition(this.currentPosition);

      // Calculate the time needed to reach the target position
      const positionDifference = Math.abs(plcTargetPosition - plcCurrentPosition);
      const movementTime = calculateMovementTimeMs(
        this.upDownTime,
        this.currentPosition,
        this.targetPosition,
      );

      this.log.debug(`${this.jalousieInfo.name} - Movement calculation: ${positionDifference}% movement, estimated ${movementTime}ms`);

      if (positionDifference === 0) {
        // Already at target position
        this.log.debug(`${this.jalousieInfo.name} - Already at target position`);
        return;
      }

      // Determine direction and start movement
      if (plcTargetPosition < plcCurrentPosition) {
        // In PLC terms, smaller position value means moving up/opening
        this.positionState = this.POSITION_STATE.INCREASING;
        this.service.updateCharacteristic(
          this.platform.Characteristic.PositionState,
          this.POSITION_STATE.INCREASING,
        );

        // Send command to move up - only send one command
        const response = await this.transport(`SET:${this.registerPath}.WEBUP`, 'TRUE');
        if (!response.includes('DIFF:') && !response.includes(',1')) {
          throw new Error(`Failed to start up movement, response: ${response}`);
        }
        this.log.debug(`${this.jalousieInfo.name} - Moving UP for ${movementTime}ms`);
      } else {
        // In PLC terms, larger position value means moving down/closing
        this.positionState = this.POSITION_STATE.DECREASING;
        this.service.updateCharacteristic(
          this.platform.Characteristic.PositionState,
          this.POSITION_STATE.DECREASING,
        );

        // Send command to move down - only send one command
        const response = await this.transport(`SET:${this.registerPath}.WEBDW`, 'TRUE');
        if (!response.includes('DIFF:') && !response.includes(',1')) {
          throw new Error(`Failed to start down movement, response: ${response}`);
        }
        this.log.debug(`${this.jalousieInfo.name} - Moving DOWN for ${movementTime}ms`);
      }

      this.moving = true;

      // Set a timeout to stop the movement after the calculated time
      this.operationTimeout = setTimeout(async () => {
        this.log.debug(`${this.jalousieInfo.name} - Timed movement complete, stopping`);

        // Send the same command again to stop movement
        if (this.positionState === this.POSITION_STATE.INCREASING) {
          await this.transport(`SET:${this.registerPath}.WEBUP`, 'TRUE');
        } else if (this.positionState === this.POSITION_STATE.DECREASING) {
          await this.transport(`SET:${this.registerPath}.WEBDW`, 'TRUE');
        }

        // Update state after sending the stop command
        this.moving = false;
        this.positionState = this.POSITION_STATE.STOPPED;

        // Update HomeKit characteristics
        this.service.updateCharacteristic(
          this.platform.Characteristic.PositionState,
          this.POSITION_STATE.STOPPED,
        );

        // Update the current position to match target since we've stopped at the desired point
        this.currentPosition = this.targetPosition;
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentPosition,
          this.currentPosition,
        );

        this.log.info(`${this.jalousieInfo.name} - Stopped at target position ${this.targetPosition}%`);

        // Update real position from PLC after a short delay
        setTimeout(async () => {
          await this.updateCurrentPositionAndState();
        }, 2000);
      }, movementTime);
    } catch (error) {
      this.log.error(`Error setting position for ${this.jalousieInfo.name}: ${error}`);
      // Reset to stopped state on error
      this.positionState = this.POSITION_STATE.STOPPED;
      this.service.updateCharacteristic(
        this.platform.Characteristic.PositionState,
        this.POSITION_STATE.STOPPED,
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
  async handleHoldPositionSet(value: CharacteristicValue) {
    if (value) {
      this.log.info(`Hold position requested for ${this.jalousieInfo.name}`);

      // Cancel any operation timeout
      if (this.operationTimeout) {
        clearTimeout(this.operationTimeout);
        this.operationTimeout = undefined;
      }

      // Send the same command again to stop movement
      if (this.positionState === this.POSITION_STATE.INCREASING) {
        await this.transport(`SET:${this.registerPath}.WEBUP`, 'TRUE');
      } else if (this.positionState === this.POSITION_STATE.DECREASING) {
        await this.transport(`SET:${this.registerPath}.WEBDW`, 'TRUE');
      }

      // Update state
      this.moving = false;
      this.positionState = this.POSITION_STATE.STOPPED;

      // Update HomeKit characteristics
      this.service.updateCharacteristic(
        this.platform.Characteristic.PositionState,
        this.POSITION_STATE.STOPPED,
      );

      // Update current position from PLC
      await this.updateCurrentPositionAndState();

      // Update target to match current
      this.targetPosition = this.currentPosition;
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetPosition,
        this.targetPosition,
      );
    }
  }

  /**
   * Stop jalousie movement and update state.
   *
   * No-op when nothing is moving — issuing the toggle in that case
   * would just kick the PLC back into motion (re-sending WEBUP/WEBDW
   * is the start command).
   *
   * NOTE: this method intentionally does NOT touch targetPosition.
   * Callers can be in either of two situations:
   *   - handleTargetPositionSet: just stored a new target; stopMovement
   *     resetting it to currentPosition would silently lose the user's
   *     request and the post-timeout `currentPosition = targetPosition`
   *     assignment would then snap back to the wrong value.
   *   - handleHoldPositionSet: target should match the place where
   *     movement actually stopped — but the caller refreshes
   *     currentPosition itself afterwards and updates the target there.
   */
  private async stopMovement() {
    if (this.positionState === this.POSITION_STATE.STOPPED) {
      return;
    }
    try {
      // Send the same command again to stop movement
      if (this.positionState === this.POSITION_STATE.INCREASING) {
        const response = await this.transport(`SET:${this.registerPath}.WEBUP`, 'TRUE');
        if (!response.includes('DIFF:')) {
          this.log.warn(`Unexpected response when stopping up movement: ${response}`);
        }
      } else if (this.positionState === this.POSITION_STATE.DECREASING) {
        const response = await this.transport(`SET:${this.registerPath}.WEBDW`, 'TRUE');
        if (!response.includes('DIFF:')) {
          this.log.warn(`Unexpected response when stopping down movement: ${response}`);
        }
      }

      // Update state
      this.moving = false;
      this.positionState = this.POSITION_STATE.STOPPED;

      // Update HomeKit characteristics
      this.service.updateCharacteristic(
        this.platform.Characteristic.PositionState,
        this.POSITION_STATE.STOPPED,
      );

      // Get current position after stopping. Caller decides whether
      // to align targetPosition with this new currentPosition.
      await this.updateCurrentPosition();

      this.log.debug(`${this.jalousieInfo.name} - Movement stopped at position ${this.currentPosition}%`);
    } catch (error) {
      this.log.error(`Error stopping movement for ${this.jalousieInfo.name}: ${error}`);
    }
  }

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
        state: this.positionState,
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
      const positionResponse = await this.transport(`GET:${this.registerPath}.POSIT`, '');
      const plcPosition = parsePosit(positionResponse);
      if (plcPosition !== null) {
        // Convert PLC position to HomeKit position (invert the value)
        // PLC: 100 = closed, 0 = open
        // HomeKit: 0 = closed, 100 = open
        const newPosition = 100 - plcPosition;

        // Only update and log if the position has changed
        if (newPosition !== this.currentPosition) {
          this.log.debug(`Position update for ${this.jalousieInfo.name}: ${newPosition}% (PLC POSIT: ${plcPosition})`);
          this.currentPosition = newPosition;

          // Update HomeKit
          this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentPosition,
            this.currentPosition,
          );
        }

        return this.currentPosition;
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
      const runResponse = await this.transport(`GET:${this.registerPath}.GTSAP1_SHUTTER_run`, '');
      const isRunning = isFlagTrue(runResponse);

      // If not running, set to stopped
      if (!isRunning) {
        if (this.positionState !== this.POSITION_STATE.STOPPED) {
          this.log.debug(`${this.jalousieInfo.name} - Movement detected as STOPPED`);
          this.positionState = this.POSITION_STATE.STOPPED;
          this.moving = false;
          this.service.updateCharacteristic(
            this.platform.Characteristic.PositionState,
            this.POSITION_STATE.STOPPED,
          );

          // If we reached a position close to target, update target to match current
          if (Math.abs(this.currentPosition - this.targetPosition) <= 5) {
            this.targetPosition = this.currentPosition;
            this.service.updateCharacteristic(
              this.platform.Characteristic.TargetPosition,
              this.targetPosition,
            );
          }
        }
        return this.positionState;
      }

      // If running, check direction by querying both flags rather than
      // inferring "not up = down" — during PLC state transitions both
      // flags can briefly be 0 and that lie produced spurious DECREASING.
      const [upResponse, downResponse] = await Promise.all([
        this.transport(`GET:${this.registerPath}.GTSAP1_SHUTTER_up`, ''),
        this.transport(`GET:${this.registerPath}.GTSAP1_SHUTTER_down`, ''),
      ]);
      const isMovingUp = isFlagTrue(upResponse);
      const isMovingDown = isFlagTrue(downResponse);

      let nextState: number | null = null;
      if (isMovingUp && !isMovingDown) {
        nextState = this.POSITION_STATE.INCREASING;
      } else if (isMovingDown && !isMovingUp) {
        nextState = this.POSITION_STATE.DECREASING;
      } else {
        // _up == _down (both off or both on) is ambiguous. Don't fabricate
        // a direction — leave positionState alone and let the next poll
        // resolve it. Log so we can spot misbehaving PLCs.
        this.log.debug(
          `${this.jalousieInfo.name} - run=1 but up=${isMovingUp} down=${isMovingDown}; keeping state`,
        );
      }

      if (nextState !== null && this.positionState !== nextState) {
        const label = nextState === this.POSITION_STATE.INCREASING ? 'UP (OPENING)' : 'DOWN (CLOSING)';
        this.log.debug(`${this.jalousieInfo.name} - Movement detected as ${label}`);
        this.positionState = nextState;
        this.moving = true;
        this.service.updateCharacteristic(
          this.platform.Characteristic.PositionState,
          nextState,
        );
      }

      return this.positionState;
    } catch (error) {
      this.log.error(`Error updating movement state for ${this.jalousieInfo.name}: ${error}`);
      return this.positionState;
    }
  }

  /**
   * Default socket-based transport. Used when no override is supplied.
   */
  private async defaultTransport(command: string, value: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let responseData = '';
      let settled = false;
      const commandTimeout = this.platform.config.commandTimeout || 5000;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        client.destroy();
        reject(new Error(`Command timeout after ${commandTimeout}ms: ${command}`));
      }, commandTimeout);

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
        settle('resolve', responseData.trim());
      });

      client.on('error', (err) => {
        this.log.error(`Error for command ${command}: ${err.message}`);
        settle('reject', err);
      });
    });
  }
}
