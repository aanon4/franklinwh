import fetch from "node-fetch";
import { createHash } from 'node:crypto';
import crc32 from 'crc/crc32';

const BASE_URL = "https://energy.franklinwh.com/";
const MAX_RETRIES = 5;

class Api {

    constructor(username, password, gateway, base) {
        const hash = createHash("md5");
        hash.update(password, "ascii");
        this.username = username;
        this.password = hash.digest("hex");
        this.gateway = gateway;
        this.base = base || BASE_URL;
        this._seqnr = 1;
    }

    async login() {
        const res = await fetch(`${this.base}hes-gateway/terminal/initialize/appUserOrInstallerLogin`, {
            method: "POST",
            body: new URLSearchParams({
                account: this.username,
                password: this.password,
                lang: "en_US",
                type: 1
            })
        });
        const json = await res.json();
        if (json.success) {
            this.token = json.result.token;
            return this;
        }
        else {
            throw new Error(json.message);
        }
    }

    async _mqttSend(cmd, payload) {
        const payloadstr = JSON.stringify(payload);
        for (let retry = 0; retry < MAX_RETRIES; retry++) {
            const res = await fetch(`${this.base}hes-gateway/terminal/sendMqtt`, {
                method: "POST",
                headers: {
                    loginToken: this.token,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    lang: "EN_US",
                    cmdType: cmd,
                    equipNo: this.gateway,
                    type: 0,
                    timeStamp: Math.floor(Date.now() / 1000),
                    snno: this._seqnr++,
                    len: payloadstr.length,
                    crc: crc32(payloadstr).toString(16),
                    dataArea: payload
                })
            });
            const json = await res.json();
            switch (json.code) {
                case 200:
                    return json;
                case 401: // Unauthenticated - reauth and retry
                    await this.login();
                    break;
                case 102: // Timeout - retry
                    break;
                case 136: // Offline
                case 400: // No gateway
                default: // Unknown
                    throw new Error(json.message);
            }
        }
        return new Error("Too many retries");
    }

    async _getData() {
        const response = await this._mqttSend(203, {
            opt: 1,
            refreshData: 1
        });
        return JSON.parse(response.result.dataArea);
    }

    async getAGateStatus() {
        const stats = await this._getData();
        return {
            solarIn: stats.p_sun,
            generatorIn: stats.p_gen,
            loadOut: stats.p_load,
            gridOut: stats.p_uti,
            batteryOut: stats.p_fhp,
            chargePercentage: stats.soc
        };
    }

}

export async function connect(username, password, gateway, base) {
    const api = new Api(username, password, gateway, base);
    return await api.login();
}
