// See https://github.com/richo/franklinwh-python

const fetch = require("node-fetch");
const createHash = require("node:crypto").createHash;
const crc32 = require("crc/crc32");

const BASE_URL = "https://energy.franklinwh.com/";
const MAX_RETRIES = 5;
const WORK_MODES = {
    tou: 1,
    self: 2,
    emer: 3,
    1: "tou",
    2: "self",
    3: "emer"
};

class Api {

    constructor(username, password, gateway, base) {
        const hash = createHash("md5");
        hash.update(password, "ascii");
        this.username = username;
        this.password = hash.digest("hex");
        this.gateway = gateway;
        this.base = base || BASE_URL;
        this.lang = "en_US";
        this._seqnr = 1;
        this._modes = {};
    }

    async login() {
        const res = await fetch(`${this.base}hes-gateway/terminal/initialize/appUserOrInstallerLogin`, {
            method: "POST",
            body: new URLSearchParams({
                account: this.username,
                password: this.password,
                lang: this.lang,
                type: 1
            })
        });
        const json = await res.json();
        if (json.success) {
            this.token = json.result.token;
            const tou = await this._getTouList();
            const list = tou.list;
            for (let i = 0; i < list.length; i++) {
                const e = list[i];
                const mode = WORK_MODES[e.workMode];
                this._modes[mode] = e.id;
                this._modes[e.id] = mode;
            }
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
                    lang: this.lang,
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
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    break;
                case 136: // Offline
                case 400: // No gateway
                default: // Unknown
                    throw new Error(json.message);
            }
        }
        throw new Error("Too many retries");
    }

    async _getData() {
        const response = await this._mqttSend(203, {
            opt: 1,
            refreshData: 1
        });
        return JSON.parse(response.result.dataArea);
    }

    async _getSwitches() {
        const response = await this._mqttSend(311, {
            opt: 0,
            order: this.gateway
        });
        return JSON.parse(response.result.dataArea);
    }

    async _getTouList() {
        const res = await fetch(`${this.base}hes-gateway/terminal/tou/getGatewayTouList`, {
            method: "POST",
            headers: {
                loginToken: this.token
            },
            body: new URLSearchParams({
                gatewayId: this.gateway,
                lang: this.lang
            })
        });
        const json = await res.json();
        if (json.success) {
            return json.result;
        }
        throw new Error(json.message);
    }

    async getAGateStatus() {
        const stats = await this._getData();
        return {
            solarIn: stats.p_sun,
            generatorIn: stats.p_gen,
            loadOut: stats.p_load,
            gridOut: stats.p_uti,
            batteryOut: stats.p_fhp,
            chargePercentage: stats.soc,
            solarInKWh: stats.kwh_sun,
            generatorInKWh: stats.kwh_gen,
            loadOutKWh: stats.kwh_load,
            gridInKWh: stats.kwh_uti_in,
            gridOutKWh: stats.kwh_uti_out,
            batteryInKWh: stats.kwh_fhp_chg,
            batteryOutKWh: stats.kwh_fhp_di
        };
    }

    async getAccessoryList() {
        const q = new URLSearchParams({
            gatewayId: this.gateway,
            lang: this.lang
        });
        const res = await fetch(`${this.base}hes-gateway/terminal/getIotAccessoryList?${q}`, {
            method: "GET",
            headers: {
                loginToken: this.token
            }
        });
        const json = await res.json();
        if (json.success) {
            return json.result;
        }
        else {
            throw new Error(json.message);
        }
    }

    async getControls() {
        const q = new URLSearchParams({
            id: this.gateway,
            lang: this.lang
        });
        const res = await fetch(`${this.base}hes-gateway/terminal/selectTerGatewayControlLoadByGatewayId?${q}`, {
            method: "GET",
            headers: {
                loginToken: this.token
            }
        });
        const json = await res.json();
        if (json.success) {
            return json.result;
        }
        else {
            throw new Error(json.message);
        }
    }

    async getMode() {
        const json = await this._getData();
        return this._modes[json.mode] || json.mode;
    }

    async setMode(mode) {
        const workMode = WORK_MODES[mode];
        if (!workMode) {
            throw new Error(`Unknown mode: ${mode}`);
        }
        const currentId = this._modes[mode];
        const current = await this._getSwitches();
        const res = await fetch(`${this.base}hes-gateway/terminal/tou/updateTouMode`, {
            method: "POST",
            headers: {
                loginToken: this.token,
                "Content-Type": "application/x-www-form-urlencoded",
                optsource: "3"
            },
            body: new URLSearchParams({
                gatewayId: this.gateway,
                lang: this.lang,
                oldIndex: "1",
                stromEn: current.stromEn,
                currendId: currentId,
                workMode: workMode
            })
        });
        const json = await res.json();
        return json.success;
    }

    async getReserve() {
        const tou = await this._getTouList();
        const current = tou.list.find(e => e.id == tou.currendId);
        return current.soc;
    }

    async setReserve(percentage) {
        percentage = Math.min(Math.max(percentage, 5), 100);
        const current = await this._getSwitches();
        const res = await fetch(`${this.base}hes-gateway/terminal/tou/updateTouMode`, {
            method: "POST",
            headers: {
                loginToken: this.token,
                "Content-Type": "application/x-www-form-urlencoded",
                optsource: "3"
            },
            body: new URLSearchParams({
                gatewayId: this.gateway,
                lang: this.lang,
                oldIndex: "1",
                stromEn: current.stromEn,
                currendId: current.runingMode,
                workMode: WORK_MODES[this._modes[current.runingMode]],
                soc: percentage
            })
        });
        const json = await res.json();
        return json.success;
    }

    async getSmartSwitches() {
        const json = await this._getSwitches();
        const smart = [];
        if (json.Sw1Name) {
            smart.push({
                name: json.Sw1Name,
                id: "sw1",
                state: !!json.Sw1ProLoad
            });
        }
        if (!json.SwMerge && json.Sw2Name) {
            smart.push({
                name: json.Sw2Name,
                id: "sw2",
                state: !!json.Sw2ProLoad
            });
        }
        if (json.Sw3Name) {
            smart.push({
                name: json.Sw3Name,
                id: "sw3",
                state: !!json.Sw3ProLoad
            });
        }
        return smart;
    }

    async updateSmartSwitches(switches) {
        const json = await this._getData();
        for (let i = 0; i < switches.length; i++) {
            switch (switches[i].id) {
                case "sw1":
                    switches[i].state = !!json.pro_load[0];
                    break;
                case "sw2":
                    switches[i].state = !!json.pro_load[1];
                    break;
                case "sw3":
                    switches[i].state = !!json.pro_load[2];
                    break;
                default:
                    break;
            }
        }
        return switches;
    }

    async setSmartSwitches(switches) {
        if (!Array.isArray(switches)) {
            switches = [ switches ];
        }

        const current = await this._getSwitches();
        current.opt = 1;
        delete current.modeChoose;
        delete current.result;

        for (let i = 0; i < switches.length; i++) {
            switch (switches[i].id) {
                case "sw1":
                    current.Sw1MsgType = 1;
                    if (switches[i].state) {
                        current.Sw1Mode = 1;
                        current.Sw1ProLoad = 0;
                        if (current.SwMerge) {
                            current.Sw2MsgType = 1;
                            current.Sw2Mode = 1;
                            current.Sw2ProLoad = 0;
                        }
                    }
                    else {
                        current.Sw1Mode = 0;
                        current.Sw1ProLoad = 1;
                        if (current.SwMerge) {
                            current.Sw2MsgType = 1;
                            current.Sw2Mode = 0;
                            current.Sw2ProLoad = 1;
                        }
                    }
                    break;
                case "sw2":
                    current.Sw2MsgType = 1;
                    if (switches[i].state) {
                        current.Sw2Mode = 1;
                        current.Sw2ProLoad = 0;
                    }
                    else {
                        current.Sw2Mode = 0;
                        current.Sw2ProLoad = 1;
                    }
                    break;
                case "sw3":
                    current.Sw3MsgType = 1;
                    if (switches[i].state) {
                        current.Sw3Mode = 1;
                        current.Sw3ProLoad = 0;
                    }
                    else {
                        current.Sw3Mode = 0;
                        current.Sw3ProLoad = 1;
                    }
                    break;
                default:
                    break;
            }
        }

        const json = await this._mqttSend(311, current);
        return json.success;
    }

}

module.exports = async function connect(username, password, gateway, base) {
    const api = new Api(username, password, gateway, base);
    return await api.login();
};
