import { AccessoryPlugin, API, Service, CharacteristicValue } from 'homebridge';
import { md5 } from "../md5";

export class iLightAccessory implements AccessoryPlugin {

  private model = "Lightbulb";
  private api: API;
  private service: Service;
  private information: Service;
  private platform: any;
  private device: any;
  private pushButton: number;

  private accStates = {
    On: false,
  }

  name: string;

  constructor( api: API, platform: any, device: any ) {
    this.name = device.name;
    this.api = api;
    this.platform = platform;
    this.device = device;
    this.pushButton = (this.device.pushButton ? 1 : 0) || this.platform.pushButton;

    this.errorCheck();

    this.service = new this.api.hap.Service.Lightbulb(this.device.name);

    this.information = new this.api.hap.Service.AccessoryInformation()
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, this.platform.manufacturer)
      .setCharacteristic(this.api.hap.Characteristic.Model, this.model + ' @ ' + this.platform.model)
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, md5(this.device.name + this.model))
      .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, this.platform.firmwareRevision);

  }

  errorCheck() {
		return
  }

  getServices(): Service[] {
		return [ this.information, this.service ];
  }

  async setOn(value: CharacteristicValue) {
		this.accStates.On = value as boolean;
  }
  async getOn(): Promise<CharacteristicValue> {
		const isOn = this.accStates.On;
		this.updateOn();
		return isOn;
  }

  updateOn() {
    return false;
  }

}
