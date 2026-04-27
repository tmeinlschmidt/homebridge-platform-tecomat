/**
 * Lightweight mocks for homebridge types so JalousieAccessory can be
 * instantiated in unit tests without pulling in the real platform.
 *
 * Only the surface area that the accessory touches is mocked. If the
 * accessory starts using a new characteristic or service method, extend
 * the mocks here rather than changing production code.
 */

import { JalousieAccessory, JalousieInfo, JalousieTransport } from '../../src/jalousieAccessory';
import { POSITION_STATE } from '../../src/jalousieLogic';

/* ----------------------- Mock characteristic IDs ----------------------- */

export const C = {
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  Name: 'Name',
  CurrentPosition: 'CurrentPosition',
  TargetPosition: 'TargetPosition',
  PositionState: 'PositionState',
  HoldPosition: 'HoldPosition',
} as const;

class MockCharacteristic {
  public listeners: { onGet?: () => unknown; onSet?: (v: unknown) => unknown } = {};
  constructor(public name: string, public value: unknown = undefined) {}
  onGet(fn: () => unknown) {
    this.listeners.onGet = fn;
    return this;
  }
  onSet(fn: (v: unknown) => unknown) {
    this.listeners.onSet = fn;
    return this;
  }
  setValue(v: unknown) {
    this.value = v;
  }
}

class MockService {
  public characteristics = new Map<string, MockCharacteristic>();
  public updates: Array<{ name: string; value: unknown }> = [];

  getCharacteristic(name: string): MockCharacteristic {
    let ch = this.characteristics.get(name);
    if (!ch) {
      ch = new MockCharacteristic(name);
      this.characteristics.set(name, ch);
    }
    return ch;
  }

  setCharacteristic(name: string, value: unknown) {
    this.getCharacteristic(name).setValue(value);
    return this;
  }

  updateCharacteristic(name: string, value: unknown) {
    this.getCharacteristic(name).setValue(value);
    this.updates.push({ name, value });
    return this;
  }
}

class MockAccessory {
  public services = new Map<string, MockService>();

  getService(serviceName: string): MockService | undefined {
    return this.services.get(serviceName);
  }

  addService(serviceName: string): MockService {
    let s = this.services.get(serviceName);
    if (!s) {
      s = new MockService();
      this.services.set(serviceName, s);
    }
    return s;
  }

  ensureService(serviceName: string): MockService {
    return this.getService(serviceName) ?? this.addService(serviceName);
  }
}

class MockLogger {
  public messages: Array<{ level: string; msg: string }> = [];
  info(msg: string) { this.messages.push({ level: 'info', msg }); }
  warn(msg: string) { this.messages.push({ level: 'warn', msg }); }
  error(msg: string) { this.messages.push({ level: 'error', msg }); }
  debug(msg: string) { this.messages.push({ level: 'debug', msg }); }
  log() { /* noop */ }
}

class MockPlatform {
  Service = {
    WindowCovering: 'WindowCovering',
    AccessoryInformation: 'AccessoryInformation',
  };
  Characteristic = C;
  config: Record<string, unknown> = { pollingInterval: 10, commandTimeout: 5000 };
}

/* --------------------------- Test scaffolding -------------------------- */

export interface BuiltAccessory {
  accessory: JalousieAccessory;
  service: MockService;
  log: MockLogger;
  raw: {
    platform: MockPlatform;
    accessory: MockAccessory;
  };
}

export function buildAccessory(opts: {
  transport?: JalousieTransport;
  upDownTime?: number;
  info?: Partial<JalousieInfo>;
} = {}): BuiltAccessory {
  const platform = new MockPlatform();
  const accessoryRaw = new MockAccessory();
  // Pre-create the AccessoryInformation service so setCharacteristic chain works.
  accessoryRaw.addService('AccessoryInformation');
  accessoryRaw.addService('WindowCovering');
  const log = new MockLogger();
  const info: JalousieInfo = {
    name: 'Test Jalousie',
    blockPath: 'TEST.CJALOUSIE',
    hasStepControl: false,
    upDownTime: opts.upDownTime ?? 30000,
    ...opts.info,
  };

  const accessory = new JalousieAccessory(
    platform as never,
    accessoryRaw as never,
    info.blockPath,
    info,
    log as never,
    {
      transport: opts.transport ?? jest.fn(),
      autoStart: false,
    },
  );

  return {
    accessory,
    service: accessoryRaw.getService('WindowCovering')!,
    log,
    raw: { platform, accessory: accessoryRaw },
  };
}

export { POSITION_STATE };
