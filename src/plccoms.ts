import { Telnet } from 'telnet-client';
import { Logging } from 'homebridge';

export class PLCComS {

  public ip: string;
  public port: number;
  public log: Logging;

  constructor(ip: string, port: number, logFunction: Logging) {
    this.ip = ip;
    this.port = port;
    this.log = logFunction;
  }

  info() {
    this.log.info('reading info from teco');
    const _info = this.readData('GETINFO:');
    this.log.info('info from teco', _info);
  }

  async readData(command: string) {
    const client = new Telnet();
    const params = {
      host: this.ip,
      port: this.port,
      timeout: 1500,
    };
    try {
      await client.connect(params);
    } catch (error) {
      // handle!
    }
    const result = await client.exec(command);
    return(result);
  }
}
