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

/**
 * Helper: route transport replies based on the command suffix so tests
 * can declare PLC state declaratively.
 */
function makeTransport(replies: Record<string, string>) {
  return jest.fn(async (command: string) => {
    for (const [suffix, reply] of Object.entries(replies)) {
      if (command.endsWith(suffix)) {
        return reply;
      }
    }
    return '';
  });
}

describe('updateMovementState', () => {
  const path = 'TEST.CJALOUSIE';
  const cmd = (suffix: string) => `GET:${path}.${suffix}`;

  it('reports STOPPED when run=0', async () => {
    const transport = makeTransport({
      'GTSAP1_SHUTTER_run': `${cmd('GTSAP1_SHUTTER_run')},0`,
    });
    const { accessory } = buildAccessory({ transport });
    await accessory.updateMovementState();
    expect(await accessory.handlePositionStateGet()).toBe(POSITION_STATE.STOPPED);
  });

  it('reports INCREASING when run=1, up=1, down=0', async () => {
    const transport = makeTransport({
      'GTSAP1_SHUTTER_run': `${cmd('GTSAP1_SHUTTER_run')},1`,
      'GTSAP1_SHUTTER_up': `${cmd('GTSAP1_SHUTTER_up')},1`,
      'GTSAP1_SHUTTER_down': `${cmd('GTSAP1_SHUTTER_down')},0`,
    });
    const { accessory } = buildAccessory({ transport });
    await accessory.updateMovementState();
    // re-read returns cached state without further transport calls beyond the same poll
    expect(await accessory.handlePositionStateGet()).toBe(POSITION_STATE.INCREASING);
  });

  it('reports DECREASING when run=1, up=0, down=1', async () => {
    const transport = makeTransport({
      'GTSAP1_SHUTTER_run': `${cmd('GTSAP1_SHUTTER_run')},1`,
      'GTSAP1_SHUTTER_up': `${cmd('GTSAP1_SHUTTER_up')},0`,
      'GTSAP1_SHUTTER_down': `${cmd('GTSAP1_SHUTTER_down')},1`,
    });
    const { accessory } = buildAccessory({ transport });
    await accessory.updateMovementState();
    expect(await accessory.handlePositionStateGet()).toBe(POSITION_STATE.DECREASING);
  });

  it('does NOT fabricate DECREASING when run=1 but neither up nor down is set', async () => {
    // Regression: previously, "not up" was treated as "must be down".
    const transport = makeTransport({
      'GTSAP1_SHUTTER_run': `${cmd('GTSAP1_SHUTTER_run')},1`,
      'GTSAP1_SHUTTER_up': `${cmd('GTSAP1_SHUTTER_up')},0`,
      'GTSAP1_SHUTTER_down': `${cmd('GTSAP1_SHUTTER_down')},0`,
    });
    const { accessory } = buildAccessory({ transport });
    // Initial state is STOPPED — must remain so under ambiguous flags.
    await accessory.updateMovementState();
    expect(await accessory.handlePositionStateGet()).toBe(POSITION_STATE.STOPPED);
  });

  it('keeps last known direction when both up and down briefly read true', async () => {
    // Establish DECREASING state first.
    const transport = makeTransport({
      'GTSAP1_SHUTTER_run': `${cmd('GTSAP1_SHUTTER_run')},1`,
      'GTSAP1_SHUTTER_up': `${cmd('GTSAP1_SHUTTER_up')},0`,
      'GTSAP1_SHUTTER_down': `${cmd('GTSAP1_SHUTTER_down')},1`,
    });
    const { accessory } = buildAccessory({ transport });
    await accessory.updateMovementState();
    expect(await accessory.handlePositionStateGet()).toBe(POSITION_STATE.DECREASING);

    // Now both flags read 1 — keep DECREASING rather than flipping.
    transport.mockImplementation(makeTransport({
      'GTSAP1_SHUTTER_run': `${cmd('GTSAP1_SHUTTER_run')},1`,
      'GTSAP1_SHUTTER_up': `${cmd('GTSAP1_SHUTTER_up')},1`,
      'GTSAP1_SHUTTER_down': `${cmd('GTSAP1_SHUTTER_down')},1`,
    }));
    await accessory.updateMovementState();
    expect(await accessory.handlePositionStateGet()).toBe(POSITION_STATE.DECREASING);
  });
});
