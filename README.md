# Homebridge PLC Jalousie Plugin

This Homebridge plugin connects to a PLC server to discover and control jalousies (blinds/shutters).

## Features

- Automatically discovers jalousie devices from your PLC
- Controls jalousies (up/down/position)
- Configurable PLC connection settings
- Real-time status updates
- Support for step-by-step control for precise positioning

## Installation

```bash
npm install -g homebridge-plc-jalousie
```

## Configuration

Add the following to your Homebridge config.json:

```json
{
  "platforms": [
    {
      "platform": "PlcJalousiePlatform",
      "name": "PLC Jalousie Controller",
      "ipAddress": "192.168.1.100",
      "port": 4840,
      "pollingInterval": 10,
      "commandTimeout": 5000,
      "debug": false
    }
  ]
}
```

### Configuration Parameters

| Parameter | Description |
|-----------|-------------|
| platform | Must be "PlcJalousiePlatform" |
| name | Plugin name as displayed in Homebridge logs |
| ipAddress | IP address of your PLC server |
| port | Port number of your PLC server |
| pollingInterval | How often to update status (in seconds) |
| commandTimeout | Timeout for PLC commands (in milliseconds) |
| debug | Enable additional logging |

## How It Works

The plugin connects to your PLC server and:

1. Sends a "LIST:" command to discover all available registers
2. Parses the response to identify jalousie control blocks
3. Retrieves the name for each jalousie using "GET:" commands
4. Exposes each jalousie to HomeKit as a window covering accessory
5. Controls the jalousies by sending "SET:" commands with the appropriate values

## PLC Protocol

The plugin communicates with the PLC using the following commands:

- `LIST:` - Gets all available registers
- `GET:<register>` - Gets the value of a specific register
- `SET:<register>,<value>` - Sets a value to a specific register

## Troubleshooting

If you experience issues:

1. Enable debug mode in the configuration
2. Check Homebridge logs for detailed information
3. Verify PLC connection settings
4. Ensure your PLC is properly configured to accept and process the commands

## License

Apache-2.0
