import { Telnet } from 'telnet-client';
import { Logging } from 'homebridge';

export class PLCComS {

  private readonly ip: string;
  private readonly port: number;
  private readonly log: Logging;
  private telnetClient: Telnet;

  constructor(ip: string, port: number, logFunction: Logging) {
    this.ip = ip;
    this.port = port;
    this.log = logFunction;
    this.telnetClient = new Telnet();
    this.connectToPLC();
  }

  async connectToPLC() {
    this.log.info(`connecting to ${this.ip}:${this.port}`);
    await this.telnetClient.connect({host: this.ip, port: this.port, timeout: 1500, echoLines: 0});
  }

  info() {
    this.log.info('reading info from teco');
    const _info = this.readData('GETINFO:');
    this.log.info('info from teco', _info);
  }

  async readData(command: string) {
    const result = await this.telnetClient.exec(command);
    return(result);
  }
}
