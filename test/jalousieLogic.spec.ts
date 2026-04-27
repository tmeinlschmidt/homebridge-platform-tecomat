import {
  POSITION_STATE,
  calculateMovementTimeMs,
  directionForTarget,
  directionToPositionState,
  homekitToPlcPosition,
  isFlagTrue,
  parseIntProperty,
  parseJalousieBlocks,
  parsePosit,
  parseQuotedProperty,
  parseUpDownTime,
  plcToHomekitPosition,
} from '../src/jalousieLogic';

describe('position inversion', () => {
  it('inverts HomeKit ↔ PLC at the endpoints', () => {
    expect(homekitToPlcPosition(0)).toBe(100);
    expect(homekitToPlcPosition(100)).toBe(0);
    expect(plcToHomekitPosition(0)).toBe(100);
    expect(plcToHomekitPosition(100)).toBe(0);
  });

  it('is its own inverse', () => {
    for (const x of [0, 17, 50, 73, 100]) {
      expect(plcToHomekitPosition(homekitToPlcPosition(x))).toBe(x);
    }
  });
});

describe('calculateMovementTimeMs', () => {
  it('zero delta -> zero ms', () => {
    expect(calculateMovementTimeMs(30000, 50, 50)).toBe(0);
  });

  it('full travel takes full upDownTime', () => {
    expect(calculateMovementTimeMs(30000, 0, 100)).toBe(30000);
    expect(calculateMovementTimeMs(30000, 100, 0)).toBe(30000);
  });

  it('half travel takes half upDownTime', () => {
    expect(calculateMovementTimeMs(30000, 0, 50)).toBe(15000);
    expect(calculateMovementTimeMs(30000, 100, 50)).toBe(15000);
  });

  it('rounds up partial milliseconds', () => {
    // 30000 * (1/100) = 300 exactly, no rounding
    expect(calculateMovementTimeMs(30000, 0, 1)).toBe(300);
    // 12345 * (1/100) = 123.45 -> 124
    expect(calculateMovementTimeMs(12345, 0, 1)).toBe(124);
  });

  it('is symmetric in direction', () => {
    expect(calculateMovementTimeMs(20000, 30, 70)).toBe(
      calculateMovementTimeMs(20000, 70, 30),
    );
  });
});

describe('directionForTarget', () => {
  it('returns "none" when already at target', () => {
    expect(directionForTarget(50, 50)).toBe('none');
  });

  it('"up" means HomeKit position increases (opening)', () => {
    expect(directionForTarget(20, 80)).toBe('up');
  });

  it('"down" means HomeKit position decreases (closing)', () => {
    expect(directionForTarget(80, 20)).toBe('down');
  });
});

describe('directionToPositionState', () => {
  it('maps to homebridge constants', () => {
    expect(directionToPositionState('up')).toBe(POSITION_STATE.INCREASING);
    expect(directionToPositionState('down')).toBe(POSITION_STATE.DECREASING);
    expect(directionToPositionState('none')).toBe(POSITION_STATE.STOPPED);
  });
});

describe('parseIntProperty / parsePosit / parseUpDownTime', () => {
  it('extracts an integer property value', () => {
    expect(parsePosit('GET:foo.bar.POSIT,42\n')).toBe(42);
    expect(parseUpDownTime('GET:foo.bar.UPDWTIME,30000')).toBe(30000);
  });

  it('returns null on missing field', () => {
    expect(parsePosit('GET:foo.bar.OTHER,42')).toBeNull();
    expect(parseUpDownTime('')).toBeNull();
  });

  it('returns null on garbage values', () => {
    expect(parsePosit('GET:foo.POSIT,abc')).toBeNull();
  });

  it('handles arbitrary property names safely', () => {
    expect(parseIntProperty('GET:x.y.z.WHATEVER,7', 'WHATEVER')).toBe(7);
  });
});

describe('parsePosit (lenient + clamped)', () => {
  it('accepts decimal values and rounds to nearest integer', () => {
    expect(parsePosit('GET:foo.POSIT,42.4')).toBe(42);
    expect(parsePosit('GET:foo.POSIT,42.6')).toBe(43);
  });

  it('accepts signed values and clamps to 0..100', () => {
    expect(parsePosit('GET:foo.POSIT,-5')).toBe(0);
    expect(parsePosit('GET:foo.POSIT,+150')).toBe(100);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePosit('GET:foo.POSIT,  17.0  ')).toBe(17);
  });

  it('still returns null for non-numeric replies', () => {
    expect(parsePosit('GET:foo.POSIT,oops')).toBeNull();
    expect(parsePosit('')).toBeNull();
  });
});

describe('parseQuotedProperty', () => {
  it('extracts a quoted value', () => {
    expect(parseQuotedProperty('GET:foo.JALOUSIENAME,"Living Room"', 'JALOUSIENAME'))
      .toBe('Living Room');
  });

  it('returns null when missing', () => {
    expect(parseQuotedProperty('GET:foo.OTHER,"x"', 'JALOUSIENAME')).toBeNull();
  });

  it('returns empty string for empty quoted value', () => {
    expect(parseQuotedProperty('GET:foo.NAME,""', 'NAME')).toBe('');
  });
});

describe('isFlagTrue', () => {
  it('matches ,1', () => {
    expect(isFlagTrue('GET:foo.run,1')).toBe(true);
  });

  it('matches ,TRUE', () => {
    expect(isFlagTrue('GET:foo.run,TRUE')).toBe(true);
  });

  it('false for ,0 / ,FALSE', () => {
    expect(isFlagTrue('GET:foo.run,0')).toBe(false);
    expect(isFlagTrue('GET:foo.run,FALSE')).toBe(false);
  });

  it('false for empty/missing', () => {
    expect(isFlagTrue('')).toBe(false);
  });
});

describe('parseJalousieBlocks', () => {
  it('extracts unique CJALOUSIE blocks from a LIST response', () => {
    const list = [
      'LIST:Foo.Bar.CJALOUSIE.POSIT',
      'LIST:Foo.Bar.CJALOUSIE.UPDWTIME',
      'LIST:Foo.Baz.CJALOUSIE.POSIT',
      'LIST:Other.X.Y.UNRELATED',
    ].join('\n');

    expect(parseJalousieBlocks(list).sort()).toEqual([
      'Foo.Bar.CJALOUSIE',
      'Foo.Baz.CJALOUSIE',
    ]);
  });

  it('returns empty array when no jalousie blocks present', () => {
    expect(parseJalousieBlocks('LIST:Foo.Other.X')).toEqual([]);
  });

  it('handles empty input', () => {
    expect(parseJalousieBlocks('')).toEqual([]);
  });
});
