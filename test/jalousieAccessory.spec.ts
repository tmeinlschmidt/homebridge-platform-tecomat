import { buildAccessory, C, POSITION_STATE } from './helpers/mocks';

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

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

describe('stopMovement (no-op when already stopped)', () => {
  it('does not issue an extra POSIT poll when handleTargetPositionSet runs from STOPPED', async () => {
    // Regression: stopMovement used to call updateCurrentPosition()
    // and overwrite the target even when nothing was moving. After
    // the fix, the first transport call should be the SET to start
    // movement — no GET:POSIT issued beforehand.
    jest.useFakeTimers();
    try {
      const transport = jest.fn(async (command: string) => {
        if (command.endsWith('.POSIT')) {
          return 'GET:TEST.CJALOUSIE.POSIT,0';
        }
        return 'DIFF:1';
      });
      const { accessory } = buildAccessory({ transport, upDownTime: 10000 });
      // currentPosition defaults to 100 (open). Drive target to 50.
      // PLC current=0, target=50 → DECREASING (close direction).
      await accessory.handleTargetPositionSet(50);

      const firstCommand = transport.mock.calls[0][0] as string;
      expect(firstCommand).toMatch(/^SET:.*\.WEBDW$/);
      const positBeforeSet = transport.mock.calls
        .map((c) => c[0] as string)
        .filter((c) => c.endsWith('.POSIT'));
      expect(positBeforeSet).toEqual([]);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

describe('handleTargetPositionSet — preserves user-requested target', () => {
  it('does not clobber the new target when stopMovement runs mid-flight', async () => {
    // Regression for the target-clobber bug: stopMovement used to
    // reset targetPosition = currentPosition. If handleTargetPositionSet
    // was called while the jalousie was moving, the new target was
    // silently lost and the post-timeout snap-to-target jumped back to
    // the old position.
    jest.useFakeTimers();
    try {
      const transport = jest.fn(async (command: string) => {
        if (command.endsWith('.POSIT')) {
          return 'GET:TEST.CJALOUSIE.POSIT,80'; // PLC says 80 → HomeKit 20 (current)
        }
        return 'DIFF:1';
      });
      const { accessory } = buildAccessory({ transport, upDownTime: 10000 });

      // Force the accessory into INCREASING state at HomeKit position 20,
      // mid-movement to old target 80.
      const internals = accessory as unknown as {
        currentPosition: number;
        targetPosition: number;
        positionState: number;
      };
      internals.currentPosition = 20;
      internals.targetPosition = 80;
      internals.positionState = POSITION_STATE.INCREASING;

      // User changes mind — new target 60.
      await accessory.handleTargetPositionSet(60);

      // After stopMovement and the start of new movement, target must
      // still be the user's 60 — not the 20 it would have been reset to
      // by the bug.
      expect(accessory.handleTargetPositionGet()).toBe(60);
      expect(internals.targetPosition).toBe(60);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

describe('updateMovementState — target resync on stop', () => {
  const path = 'TEST.CJALOUSIE';

  it('syncs target to current when stop is observed without an active operation', async () => {
    // Regression for the "5% guard" bug: if a movement aborted (manual
    // stop, obstacle) at a position far from the requested target,
    // HomeKit kept the stale target forever.
    const transport = jest.fn(async (command: string) => {
      if (command.endsWith('.GTSAP1_SHUTTER_run')) {
        return `GET:${path}.GTSAP1_SHUTTER_run,0`;
      }
      return '';
    });
    const { accessory } = buildAccessory({ transport });
    const internals = accessory as unknown as {
      currentPosition: number;
      targetPosition: number;
      positionState: number;
    };
    // Pretend we were observing INCREASING toward target 80 but the PLC
    // halted at 35 (15% away — well beyond the old 5% guard).
    internals.currentPosition = 35;
    internals.targetPosition = 80;
    internals.positionState = POSITION_STATE.INCREASING;

    await accessory.updateMovementState();

    expect(accessory.handleTargetPositionGet()).toBe(35);
    expect(internals.targetPosition).toBe(35);
  });

  it('does NOT touch target when run=0 while an operation is pending', async () => {
    // Regression: while our own operationTimeout drives movement, run=0
    // can flicker briefly between commands. Don't reset the user's
    // target then — the timer will reconcile current/target on completion.
    const transport = jest.fn(async (command: string) => {
      if (command.endsWith('.GTSAP1_SHUTTER_run')) {
        return `GET:${path}.GTSAP1_SHUTTER_run,0`;
      }
      return '';
    });
    const { accessory } = buildAccessory({ transport });
    const internals = accessory as unknown as {
      currentPosition: number;
      targetPosition: number;
      positionState: number;
      operationTimeout?: NodeJS.Timeout;
    };
    internals.currentPosition = 40;
    internals.targetPosition = 80;
    internals.positionState = POSITION_STATE.INCREASING;
    // Simulate an in-flight operation.
    internals.operationTimeout = setTimeout(() => undefined, 999999);

    try {
      await accessory.updateMovementState();
      expect(internals.targetPosition).toBe(80);
    } finally {
      if (internals.operationTimeout) {
        clearTimeout(internals.operationTimeout);
      }
    }
  });
});

describe('stop-toggle race — never restart a stopped jalousie', () => {
  const path = 'TEST.CJALOUSIE';

  it('operationTimeout skips WEBUP/WEBDW when the PLC has already stopped', async () => {
    // Regression for the toggle bug: re-sending WEBUP/WEBDW is the
    // *start* command. If the PLC reached its limit before our timer
    // fired, the timed-stop used to kick the jalousie right back into
    // motion. Now we check _run first.
    jest.useFakeTimers();
    try {
      const replies = new Map<string, string>([
        ['.POSIT', `GET:${path}.POSIT,40`],
        // PLC says it's already stopped by the time the timer fires.
        ['.GTSAP1_SHUTTER_run', `GET:${path}.GTSAP1_SHUTTER_run,0`],
      ]);
      const transport = jest.fn(async (command: string) => {
        for (const [suffix, reply] of replies) {
          if (command.endsWith(suffix)) {
            return reply;
          }
        }
        return 'DIFF:1';
      });
      const { accessory } = buildAccessory({ transport, upDownTime: 10000 });

      // Start at HomeKit 100 (open). Drive target to 50 — DECREASING,
      // movementTime = ceil(10000 * 50/100) = 5000 ms.
      await accessory.handleTargetPositionSet(50);

      // Count toggle commands issued before and after the timer fires.
      const togglesBefore = transport.mock.calls
        .map((c) => c[0] as string)
        .filter((c) => /\.(WEBUP|WEBDW)$/.test(c)).length;
      expect(togglesBefore).toBe(1); // the initial start command

      await jest.advanceTimersByTimeAsync(6000);

      const togglesAfter = transport.mock.calls
        .map((c) => c[0] as string)
        .filter((c) => /\.(WEBUP|WEBDW)$/.test(c)).length;
      // Timer fired but PLC was already stopped → no extra toggle issued.
      expect(togglesAfter).toBe(togglesBefore);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('operationTimeout DOES toggle when the PLC is still running', async () => {
    jest.useFakeTimers();
    try {
      const transport = jest.fn(async (command: string) => {
        if (command.endsWith('.POSIT')) {
          return `GET:${path}.POSIT,40`;
        }
        if (command.endsWith('.GTSAP1_SHUTTER_run')) {
          return `GET:${path}.GTSAP1_SHUTTER_run,1`;
        }
        return 'DIFF:1';
      });
      const { accessory } = buildAccessory({ transport, upDownTime: 10000 });

      await accessory.handleTargetPositionSet(50);

      const before = transport.mock.calls
        .map((c) => c[0] as string)
        .filter((c) => /\.(WEBUP|WEBDW)$/.test(c)).length;

      await jest.advanceTimersByTimeAsync(6000);

      const after = transport.mock.calls
        .map((c) => c[0] as string)
        .filter((c) => /\.(WEBUP|WEBDW)$/.test(c)).length;
      expect(after).toBe(before + 1); // the stop toggle
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('stopMovement skips the toggle when the PLC reports already stopped', async () => {
    // State drift between accessory and PLC: accessory thinks
    // INCREASING, PLC actually idle. Toggle would restart movement.
    jest.useFakeTimers();
    try {
      const transport = jest.fn(async (command: string) => {
        if (command.endsWith('.GTSAP1_SHUTTER_run')) {
          return `GET:${path}.GTSAP1_SHUTTER_run,0`;
        }
        if (command.endsWith('.POSIT')) {
          return `GET:${path}.POSIT,30`;
        }
        return 'DIFF:1';
      });
      const { accessory } = buildAccessory({ transport, upDownTime: 10000 });
      const internals = accessory as unknown as {
        currentPosition: number;
        targetPosition: number;
        positionState: number;
      };
      internals.currentPosition = 70;
      internals.targetPosition = 70;
      internals.positionState = POSITION_STATE.INCREASING;

      // Trigger stopMovement via the public path (handleTargetPositionSet
      // calls it before computing movement).
      await accessory.handleTargetPositionSet(71);

      const toggleCommands = transport.mock.calls
        .map((c) => c[0] as string)
        .filter((c) => /\.(WEBUP|WEBDW)$/.test(c));

      // Only one toggle should appear: the *new* movement start. The
      // pre-movement stop step must have been skipped because the PLC
      // reports run=0.
      expect(toggleCommands.length).toBe(1);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});
