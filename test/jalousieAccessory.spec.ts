import { buildAccessory, C, POSITION_STATE } from './helpers/mocks';

describe('JalousieAccessory — wiring', () => {
  it('initialises HomeKit characteristics and accessory metadata', () => {
    const { service } = buildAccessory();
    // Required characteristics are registered.
    expect(service.characteristics.has(C.CurrentPosition)).toBe(true);
    expect(service.characteristics.has(C.TargetPosition)).toBe(true);
    expect(service.characteristics.has(C.PositionState)).toBe(true);
    expect(service.characteristics.has(C.HoldPosition)).toBe(true);
  });

  it('handleTargetPositionGet / handlePositionStateGet return defaults before any movement', async () => {
    const { accessory } = buildAccessory();
    expect(accessory.handleTargetPositionGet()).toBe(100);
    // positionState defaults to STOPPED
    const transport = jest.fn().mockResolvedValue('GET:TEST.CJALOUSIE.GTSAP1_SHUTTER_run,0');
    const { accessory: a } = buildAccessory({ transport });
    expect(await a.handlePositionStateGet()).toBe(POSITION_STATE.STOPPED);
  });
});
