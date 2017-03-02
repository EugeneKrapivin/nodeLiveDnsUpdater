const request = require('request-promise');
const fs = require('fs-promise');
const Promise = require("bluebird");
const soap = require('soap');
const log = require('winston');

log.configure({
    transports: [
        new (log.transports.Console)({ colorize: 'level' })
    ],
    level: 'debug'
});

class LiveDnsClient{
    constructor(username, password, domain) {
        this.username = username;
        this.password = password;
        this.domain = domain;

        this.cred = {UserName: username, Password: password, DomainName: domain}
    }
    
    async getLiveDnsClientAsync() {
        if (!this.client) {
            Promise.promisifyAll(soap);
            let client = await soap.createClientAsync('https://domains.livedns.co.il/API/DomainsAPI.asmx?WSDL');
            this.client = await Promise.promisifyAll(client);
        }

        return this.client;
    }

    async upsertRecordsAsync(zones, curIP) {
        let client = await this.getLiveDnsClientAsync();
        for (let zone of zones) {
            try {
                let removeResult = await client.DeleteARecordAsync(Object.assign({HostName: zone.host}, this.cred));
                if (removeResult.DeleteARecordResult === 'A Record does not exists') {
                    log.warn(`Record ${zone.host === '' ? 'krapivin.co.il' : zone.host} could not be removed since it doesn't exist.`);
                } else {
                    log.info(`Record ${zone.host === '' ? 'krapivin.co.il' : zone.host} was successfully removed.`);
                }
                
                let createResult = await client.NewARecordAsync(Object.assign({IPAddress: curIP, TTL: zone.ttl, HostName: zone.host}, this.cred));
                if (createResult.NewARecordResult === '1') {
                    log.info('Record was successfully created', zone);
                } else {
                    log.error('Record was *not* created', zone);
                }
            } catch (ex) {
                log.error(`failed update ${zone}`, ex);
            }
        }
    }

    async getZonesAsync() {
        let client = await this.getLiveDnsClientAsync();

        return (await client.GetZoneRecordsAsync(this.cred))
            .GetZoneRecordsResult.diffgram.LiveDnsResult.ZoneRecord // yummy
            .filter(x => x.Type !== 'Name Server (NS)')
            .map(x => {
                return { 
                    host: x.Host,
                    type: x.Type, 
                    data: x.Data,
                    ttl: x.TTL
                }
            });
    }
};

class IPHandler{
    constructor(recordPath){
        this.recordPath = recordPath;
    }

    async getCurrentIPAsync() {
        return await request.get('https://api.ipify.org');
    }

    async getPreviousIPAsync() {
        if (await fs.exists(this.recordPath)) {
            try {
                return JSON.parse(await fs.readFile(this.recordPath, {encoding:'utf8'}));
            } catch (ex) {
                log.error(ex);
                await fs.remove(this.recordPath);
                return {ip: "127.0.0.1", updateTime: new Date()};
            }
        } else {
            return {ip: "127.0.0.1", updateTime: new Date()};
        }
    }

    async storeIPAsync(ip) {
        try {
            await fs.writeFile(this.recordPath, JSON.stringify({updateTime: new Date().toISOString(), ip: ip}), {encoding: 'UTF-8'});
            return true;
        } catch (ex) {
            log.error(ex);
            return false;
        }
    }
};

function fixHost(zone) {
    zone.host = zone.host.replace('.krapivin.co.il.', '');
    zone.host = zone.host.replace('.krapivin.co.il', '');
    zone.host = zone.host.replace('krapivin.co.il.', '');
    zone.host = zone.host.replace('krapivin.co.il', '');

    return zone;
};

function restoreRequiredHosts(zones, requiredHosts, curIP) {
    requiredHosts.filter(x => zones.findIndex(zone => zone.host === x) === -1)
    .forEach(host => {
        zones.push({ host: host, type: 'Host (A)', data: curIP, ttl: 14400 });
    });
    
    return zones;
};

function getUserHome() {
  return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

async function parseConfig() {
    let data;
    let locatedPath;
    log.info('locating config.json...');
    if (await fs.exists('config.json')) {
        log.warn('the config file should not be in the execution directory to avoid pushing into a public repository')
        if (process.platform === 'win32')
        {
            log.warn(`please place the file in ${getUserHome()}\\.liveDnsUpdater\\config.json`);
        } else {
            log.warn(`please place the file in ~/.liveDnsUpdater/config.json`);
        }
        locatedPath = 'config.json';
    } else if (await fs.exists(`${getUserHome()}\\.liveDnsUpdater\\config.json`)) { // windows
        log.info('found in home directory')
        locatedPath = `${getUserHome()}\\.liveDnsUpdater\\config.json`;
    } else if (await fs.exists(`~/.liveDnsUpdater/config.json`)) { // linux
        log.info('found in home directory')
        locatedPath = `~/.liveDnsUpdater/config.json`;
    } else {
        log.error('could not find config.json. Please ensure it exists at ~/.liveDnsUpdater/config.json')
        exit(-1);
    }

    log.info('parsing...');
    try {
        data = await fs.readJson(locatedPath);
    } catch (ex) {
        log.exception(ex);
        exit(-1);
    }
    if (!data.username || !data.password || !data.domain || !data.requiredHosts) {
        log.error('please ensure config file contains username/password/domain/requiredHosts')
        exit(-1);
    }

    log.info('done')
    return data;
}

async function main() {
    let config = await parseConfig();
    
    username = config.username;
    password = config.password;
    domain = config.domain;
    requiredHosts = config.requiredHosts;
    let ipRecordPath = `${getUserHome()}\\.liveDnsUpdater\\.iprecord`;
    let ipHandler = new IPHandler(ipRecordPath);
    let curIP = await ipHandler.getCurrentIPAsync();
    let previousRecord = await ipHandler.getPreviousIPAsync();
    
    if (curIP !== previousRecord.ip) {
        log.info(`ip changed (previous: ${previousRecord.ip} @ ${previousRecord.updateTime} current ${curIP})`);
        
        let client = new LiveDnsClient(username, password, domain);
        let zones = await client.getZonesAsync();
        zones = restoreRequiredHosts(zones, requiredHosts, curIP).map(zone => fixHost(zone));
        await client.upsertRecordsAsync(zones, curIP);

        if (!await ipHandler.storeIPAsync(curIP)) {
            log.warn(`failed to store app data to ${ipRecordPath}`);
        }
    } else {
        log.info(`ip did not change (${curIP})`);
    }
};

main();