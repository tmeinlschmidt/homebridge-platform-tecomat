<span align="center">

# homebridge-platform-tecomat

[![npm version](https://img.shields.io/npm/v/homebridge-platform-tecomat.svg)](https://www.npmjs.com/package/homebridge-platform-tecomat)
[![Node.js](https://img.shields.io/node/v/homebridge-platform-tecomat.svg)](https://nodejs.org)
[![License](https://img.shields.io/npm/l/homebridge-platform-tecomat.svg)](LICENSE)

A [Homebridge](https://homebridge.io) dynamic platform plugin for **Teco / Tecomat iFoxtrot** PLCs. Auto-discovers jalousie / blind blocks (`CJALOUSIE`) and exposes each one as a HomeKit `WindowCovering` accessory.

</span>

## Features

- Auto-discovery of every `CJALOUSIE` block on the PLC; one HomeKit accessory per blind
- Up / down movement and absolute position via the standard HomeKit slider
- Periodic state polling with verified stop semantics (the plugin won't kick a stopped jalousie back into motion)
- Configurable polling interval, command/discovery timeouts and rediscovery cadence
- Fully unit-tested state machine and PLC parsers

## Installation

The recommended way to install Homebridge plugins is the **Homebridge UI** — search for `homebridge-platform-tecomat` in the Plugins tab and click *Install*. The UI then renders the configuration form from `config.schema.json`.

To install from the command line:

```bash
npm install -g homebridge-platform-tecomat
```

## Configuration

Most users should configure the plugin through the Homebridge UI. To edit `config.json` directly, add a block under `platforms`:

```json
{
  "platforms": [
    {
      "platform": "HomeBridgePlatformTecomat",
      "name": "PLC Jalousie Controller",
      "ipAddress": "192.168.1.100",
      "port": 4840,
      "pollingInterval": 10,
      "commandTimeout": 5000,
      "discoveryTimeout": 15000,
      "autoDiscoveryInterval": 60,
      "debug": false
    }
  ]
}
```

The `platform` value must be exactly `HomeBridgePlatformTecomat` — that's the alias declared in both `config.schema.json` and `src/settings.ts`.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `platform` | string | — | Must be `HomeBridgePlatformTecomat` |
| `name` | string | — | Display name used in Homebridge logs |
| `ipAddress` | string | — | IP of the PLC's TCP server |
| `port` | integer | — | Port of the PLC's TCP server |
| `pollingInterval` | integer (s) | `10` | How often to refresh position/state from the PLC |
| `commandTimeout` | integer (ms) | `5000` | Per-command socket timeout |
| `discoveryTimeout` | integer (ms) | `15000` | Timeout for the initial `LIST:` discovery command |
| `autoDiscoveryInterval` | integer (min) | `60` | Rerun discovery every N minutes (0 disables) |
| `debug` | boolean | `false` | Verbose logging of every PLC command/response |

## How it works

1. Sends `LIST:` to the PLC and parses the response for `*.CJALOUSIE.*` blocks.
2. For each block, fetches `JALOUSIENAME` (or `NAME` as fallback) and `UPDWTIME`.
3. Exposes each jalousie as a HomeKit `WindowCovering` service with `CurrentPosition`, `TargetPosition`, `PositionState` and `HoldPosition` characteristics.
4. Drives motion with `SET:<path>.WEBUP,TRUE` / `SET:<path>.WEBDW,TRUE` and times the stop using `UPDWTIME`. Before issuing a stop toggle the plugin verifies `GTSAP1_SHUTTER_run` so it never restarts a jalousie that has already reached its limit.

### Position conventions

- HomeKit: `0` = fully closed, `100` = fully open
- PLC: `100` = fully closed, `0` = fully open

The plugin inverts at the boundary so the HomeKit slider feels natural.

## PLC protocol

The plugin speaks a thin newline-delimited TCP protocol:

- `LIST:` — list available registers
- `GET:<register>` — read a register
- `SET:<register>,<value>` — write a register

## Development

```bash
git clone https://github.com/tmeinlschmidt/homebridge-platform-tecomat.git
cd homebridge-platform-tecomat
npm install
npm test          # 47 unit + integration tests
npm run lint
npm run build
npm run watch     # rebuilds and runs homebridge against test/hbConfig
```

Pure logic (position math, response parsers, state machine) lives in `src/jalousieLogic.ts`. The accessory class accepts an injected transport so the suite under `test/` can drive it without real network IO.

## Troubleshooting

1. Set `"debug": true` in your config and restart Homebridge.
2. Check Homebridge logs — every PLC request/response is dumped in debug mode.
3. Verify `ipAddress` / `port` and that the PLC's TCP server accepts unauthenticated connections from your Homebridge host.
4. If the slider lags behind reality, lower `pollingInterval`.

## License

[Apache-2.0](LICENSE)
