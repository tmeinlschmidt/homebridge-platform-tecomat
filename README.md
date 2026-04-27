# Homebridge PLC Jalousie Plugin

This Homebridge plugin connects to a PLC server to discover and control jalousies (blinds/shutters). It automatically identifies jalousie devices from your PLC server and creates individual HomeKit accessories for each one.

## Features

- Automatic discovery of all jalousie devices from your PLC
- Individual accessory for each jalousie with proper naming
- Controls for up/down movement and position setting
- Real-time status updates with configurable polling interval
- Support for step-by-step control for precise positioning
- Automatic rediscovery to detect new devices
- Detailed logging for troubleshooting

## Installation

```bash
npm install -g homebridge-platform-tecomat
```

## Configuration

Add the following to your Homebridge config.json:

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

### Configuration Parameters

| Parameter | Description |
|-----------|-------------|
| platform | Must be "HomeBridgePlatformTecomat" |
| name | Plugin name as displayed in Homebridge logs |
| ipAddress | IP address of your PLC server |
| port | Port number of your PLC server |
| pollingInterval | How often to update status (in seconds) |
| commandTimeout | Timeout for PLC commands (in milliseconds) |
| discoveryTimeout | Timeout for initial discovery commands (in milliseconds) |
| autoDiscoveryInterval | How often to automatically rediscover devices (in minutes, 0 to disable) |
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
