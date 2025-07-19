//
// Copyright (C) Microsoft. All rights reserved.
//

import * as request from 'request';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as WebSocket from 'ws';
import * as which from 'which';
import { execFile } from 'child-process-promise';
import { Logger, debug } from '../logger';
import { Adapter } from './adapter';
import { Target } from '../protocols/target';
import { AdapterCollection } from './adapterCollection';
import { ITarget, IIOSDeviceTarget, IIOSProxySettings } from './adapterInterfaces';
import { IOSProtocol } from '../protocols/ios/ios';
import { IOS8Protocol } from '../protocols/ios/ios8';
import { IOS9Protocol } from '../protocols/ios/ios9';
import { IOS12Protocol } from '../protocols/ios/ios12';

export class IOSAdapter extends AdapterCollection {
    private _proxySettings: IIOSProxySettings;
    private _protocolMap: Map<Target, IOSProtocol>;

    constructor(id: string, socket: string, proxySettings: IIOSProxySettings) {
        super(id, socket, {
            port: proxySettings.proxyPort,
            proxyExePath: proxySettings.proxyPath,
            proxyExeArgs: proxySettings.proxyArgs
        });

        this._proxySettings = proxySettings;
        this._protocolMap = new Map<Target, IOSProtocol>();

        // Add error handler for this iOS adapter instance
        this.on('error', (error) => {
            Logger.error(`IOSAdapter ${this._id} error: ${error}`);
        });
    }

    public async getTargets(): Promise<ITarget[]> {
        debug(`iOSAdapter.getTargets`);

        try {
            // Step 1: Get devices from proxy with proper error handling
            const devices = await this.getDevicesFromProxy();
            if (!Array.isArray(devices) || devices.length === 0) {
                Logger.log(`IOSAdapter ${this._id} getTargets: No devices found`);
                return [];
            }

            // Step 2: Process device versions with error handling
            const processedDevices = this.processDeviceVersions(devices);

            // Step 3: Create adapters for devices with error handling
            await this.createDeviceAdapters(processedDevices);

            // Step 4: Get targets from all device adapters
            return await super.getTargets(processedDevices);
        } catch (error) {
            Logger.error(`IOSAdapter ${this._id} getTargets error: ${error}`);
            return [];
        }
    }

    public connectTo(url: string, wsFrom: WebSocket): Target | null {
        try {
            if (!url) {
                Logger.error(`IOSAdapter ${this._id} connectTo: No URL provided`);
                return null;
            }

            if (!wsFrom) {
                Logger.error(`IOSAdapter ${this._id} connectTo: No WebSocket provided`);
                return null;
            }

            const target = super.connectTo(url, wsFrom);

            if (!target) {
                Logger.error(`IOSAdapter ${this._id} connectTo: Target not found for ${url}`);
                return null;
            }

            // Setup protocol for target with error handling
            try {
                if (!this._protocolMap.has(target)) {
                    const targetData = target.data;
                    if (!targetData || !targetData.metadata) {
                        Logger.error(`IOSAdapter ${this._id} connectTo: Target has no metadata`);
                        return target; // Return target anyway, might still work
                    }

                    const deviceTarget = targetData.metadata as IIOSDeviceTarget;
                    if (!deviceTarget.version) {
                        Logger.error(`IOSAdapter ${this._id} connectTo: Target has no version info`);
                        return target; // Return target anyway, might still work
                    }

                    const protocol = this.getProtocolFor(deviceTarget.version, target);
                    if (protocol) {
                        this._protocolMap.set(target, protocol);
                    } else {
                        Logger.error(`IOSAdapter ${this._id} connectTo: Failed to create protocol for version ${deviceTarget.version}`);
                    }
                }
            } catch (protocolError) {
                Logger.error(`IOSAdapter ${this._id} connectTo protocol setup error: ${protocolError}`);
                // Return target anyway, basic functionality might still work
            }

            return target;
        } catch (error) {
            Logger.error(`IOSAdapter ${this._id} connectTo error: ${error}`);
            return null;
        }
    }

    public static async getProxySettings(args: any): Promise<IIOSProxySettings | string> {
        debug(`iOSAdapter.getProxySettings`);

        try {
            if (!args) {
                throw new Error('No arguments provided');
            }

            // Check that the proxy exists
            const proxyPath = await IOSAdapter.getProxyPath();

            if (!proxyPath) {
                throw new Error('Could not find proxy path');
            }

            // Start with remote debugging enabled
            // Use default parameters for the ios_webkit_debug_proxy executable
            const proxyPort = args.proxyPort || 9221;

            if (typeof proxyPort !== 'number' || proxyPort <= 0) {
                throw new Error(`Invalid proxy port: ${proxyPort}`);
            }

            const proxyArgs = [
                '--no-frontend',
                '--config=null:' + proxyPort + ',:' + (proxyPort + 1) + '-' + (proxyPort + 101)
            ];

            const settings: IIOSProxySettings = {
                proxyPath: proxyPath,
                proxyPort: proxyPort,
                proxyArgs: proxyArgs
            };

            return settings;
        } catch (error) {
            Logger.error(`IOSAdapter getProxySettings error: ${error}`);
            return `Failed to get proxy settings: ${error}`;
        }
    }

    private async getDevicesFromProxy(): Promise<IIOSDeviceTarget[]> {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                Logger.error(`IOSAdapter ${this._id} getDevicesFromProxy timeout after 10 seconds`);
                resolve([]);
            }, 10000);

            try {
                request(this._url, { timeout: 8000 }, (error: any, response: http.IncomingMessage, body: any) => {
                    clearTimeout(timeoutId);

                    if (error) {
                        Logger.error(`IOSAdapter ${this._id} getDevicesFromProxy request error: ${error}`);
                        resolve([]);
                        return;
                    }

                    if (!response) {
                        Logger.error(`IOSAdapter ${this._id} getDevicesFromProxy: No response received`);
                        resolve([]);
                        return;
                    }

                    if (response.statusCode !== 200) {
                        Logger.error(`IOSAdapter ${this._id} getDevicesFromProxy: HTTP ${response.statusCode}`);
                        resolve([]);
                        return;
                    }

                    if (!body) {
                        Logger.log(`IOSAdapter ${this._id} getDevicesFromProxy: Empty response body`);
                        resolve([]);
                        return;
                    }

                    try {
                        const devices: IIOSDeviceTarget[] = JSON.parse(body);

                        if (!Array.isArray(devices)) {
                            Logger.error(`IOSAdapter ${this._id} getDevicesFromProxy: Response is not an array`);
                            resolve([]);
                            return;
                        }

                        resolve(devices);
                    } catch (parseError) {
                        Logger.error(`IOSAdapter ${this._id} getDevicesFromProxy JSON parse error: ${parseError}`);
                        Logger.error(`IOSAdapter ${this._id} getDevicesFromProxy response body: ${body}`);
                        resolve([]);
                    }
                });
            } catch (requestError) {
                clearTimeout(timeoutId);
                Logger.error(`IOSAdapter ${this._id} getDevicesFromProxy request setup error: ${requestError}`);
                resolve([]);
            }
        });
    }

    private processDeviceVersions(devices: IIOSDeviceTarget[]): IIOSDeviceTarget[] {
        try {
            const processedDevices: IIOSDeviceTarget[] = [];

            devices.forEach((d, index) => {
                try {
                    if (!d) {
                        Logger.error(`IOSAdapter ${this._id} processDeviceVersions: Device at index ${index} is null`);
                        return;
                    }

                    if (d.deviceId === 'SIMULATOR') {
                        d.version = '9.3.0'; // TODO: Find a way to auto detect version. Currently hardcoding it.
                    } else if (d.deviceOSVersion) {
                        d.version = d.deviceOSVersion;
                    } else {
                        debug(`error.iosAdapter.getTargets.getDeviceVersion.failed.fallback, device=${JSON.stringify(d)}. Please update ios-webkit-debug-proxy to version 1.8.5`);
                        d.version = '9.3.0';
                    }

                    processedDevices.push(d);
                } catch (deviceError) {
                    Logger.error(`IOSAdapter ${this._id} processDeviceVersions device ${index} error: ${deviceError}`);
                    // Continue processing other devices
                }
            });

            return processedDevices;
        } catch (error) {
            Logger.error(`IOSAdapter ${this._id} processDeviceVersions error: ${error}`);
            return devices; // Return original devices if processing fails
        }
    }

    private async createDeviceAdapters(devices: IIOSDeviceTarget[]): Promise<void> {
        try {
            const adapterPromises: Promise<void>[] = [];

            devices.forEach((d) => {
                try {
                    if (!d || !d.deviceId) {
                        Logger.error(`IOSAdapter ${this._id} createDeviceAdapters: Invalid device: ${JSON.stringify(d)}`);
                        return;
                    }

                    const adapterId = `${this._id}_${d.deviceId}`;

                    if (!this._adapters.has(adapterId)) {
                        if (!d.url) {
                            Logger.error(`IOSAdapter ${this._id} createDeviceAdapters: Device ${d.deviceId} has no URL`);
                            return;
                        }

                        const parts = d.url.split(':');
                        if (parts.length <= 1) {
                            Logger.error(`IOSAdapter ${this._id} createDeviceAdapters: Invalid URL format for device ${d.deviceId}: ${d.url}`);
                            return;
                        }

                        const portStr = parts[1];
                        const port = parseInt(portStr, 10);

                        if (isNaN(port) || port <= 0) {
                            Logger.error(`IOSAdapter ${this._id} createDeviceAdapters: Invalid port for device ${d.deviceId}: ${portStr}`);
                            return;
                        }

                        // Create adapter with error handling
                        const adapterPromise = this.createSingleDeviceAdapter(adapterId, port, d.deviceId);
                        adapterPromises.push(adapterPromise);
                    }
                } catch (deviceAdapterError) {
                    Logger.error(`IOSAdapter ${this._id} createDeviceAdapters device ${d?.deviceId} error: ${deviceAdapterError}`);
                }
            });

            if (adapterPromises.length > 0) {
                await Promise.allSettled(adapterPromises);
            }
        } catch (error) {
            Logger.error(`IOSAdapter ${this._id} createDeviceAdapters error: ${error}`);
        }
    }

    private async createSingleDeviceAdapter(adapterId: string, port: number, deviceId: string): Promise<void> {
        try {
            // Create a new adapter for this device and add it to our list
            const adapter = new Adapter(adapterId, this._proxyUrl, { port: port });

            // Add error handling for adapter events
            adapter.on('error', (error) => {
                Logger.error(`IOSAdapter ${this._id} device adapter ${adapterId} error: ${error}`);
            });

            adapter.on('socketClosed', (id) => {
                try {
                    this.emit('socketClosed', id);
                } catch (emitError) {
                    Logger.error(`IOSAdapter ${this._id} socketClosed emit error: ${emitError}`);
                }
            });

            // Start adapter with error handling
            try {
                await adapter.start();
                this._adapters.set(adapterId, adapter);
                Logger.log(`IOSAdapter ${this._id} created adapter for device ${deviceId} on port ${port}`);
            } catch (startError) {
                Logger.error(`IOSAdapter ${this._id} failed to start adapter ${adapterId}: ${startError}`);
            }
        } catch (error) {
            Logger.error(`IOSAdapter ${this._id} createSingleDeviceAdapter ${adapterId} error: ${error}`);
        }
    }

    private static async getProxyPath(): Promise<string> {
        debug(`iOSAdapter.getProxyPath`);

        return new Promise((resolve, reject) => {
            try {
                const platform = os.platform();

                if (platform === 'win32') {
                    try {
                        const scoopPath = process.env.SCOOP;
                        const userProfile = process.env.USERPROFILE;

                        let proxy: string;
                        if (scoopPath) {
                            proxy = path.resolve(__dirname, scoopPath + '/apps/ios-webkit-debug-proxy/current/ios_webkit_debug_proxy.exe');
                        } else if (userProfile) {
                            proxy = path.resolve(__dirname, userProfile + '/scoop/apps/ios-webkit-debug-proxy/current/ios_webkit_debug_proxy.exe');
                        } else {
                            reject('USERPROFILE environment variable not found');
                            return;
                        }

                        fs.stat(proxy, (err, stats) => {
                            if (err) {
                                reject(`ios_webkit_debug_proxy.exe not found at ${proxy}. Please install 'scoop install ios-webkit-debug-proxy'`);
                            } else if (stats.isFile()) {
                                resolve(proxy);
                            } else {
                                reject(`Path exists but is not a file: ${proxy}`);
                            }
                        });
                    } catch (windowsError) {
                        reject(`Windows proxy path resolution error: ${windowsError}`);
                    }
                } else if (platform === 'darwin' || platform === 'linux') {
                    which('ios_webkit_debug_proxy', function (err, resolvedPath) {
                        if (err) {
                            reject('ios_webkit_debug_proxy not found. Please install ios_webkit_debug_proxy (https://github.com/google/ios-webkit-debug-proxy)');
                        } else if (!resolvedPath) {
                            reject('ios_webkit_debug_proxy resolved to empty path');
                        } else {
                            resolve(resolvedPath);
                        }
                    });
                } else {
                    reject(`Unsupported platform: ${platform}`);
                }
            } catch (error) {
                reject(`getProxyPath error: ${error}`);
            }
        });
    }

    private getProtocolFor(version: string, target: Target): IOSProtocol | null {
        debug(`iOSAdapter.getProtocolFor`);

        try {
            if (!version || typeof version !== 'string') {
                Logger.error(`IOSAdapter ${this._id} getProtocolFor: Invalid version: ${version}`);
                return new IOS9Protocol(target); // Default fallback
            }

            if (!target) {
                Logger.error(`IOSAdapter ${this._id} getProtocolFor: No target provided`);
                return null;
            }

            const parts = version.split('.');
            if (parts.length === 0) {
                Logger.error(`IOSAdapter ${this._id} getProtocolFor: Could not parse version: ${version}`);
                return new IOS9Protocol(target); // Default fallback
            }

            const majorStr = parts[0];
            const major = parseInt(majorStr, 10);

            if (isNaN(major)) {
                Logger.error(`IOSAdapter ${this._id} getProtocolFor: Invalid major version: ${majorStr}`);
                return new IOS9Protocol(target); // Default fallback
            }

            if (major <= 8) {
                return new IOS8Protocol(target);
            }

            if (parts.length > 1) {
                const minorStr = parts[1];
                const minor = parseInt(minorStr, 10);

                if (!isNaN(minor) && (major > 12 || (major >= 12 && minor >= 2))) {
                    return new IOS12Protocol(target);
                }
            }

            // Default to iOS 9 protocol
            return new IOS9Protocol(target);
        } catch (error) {
            Logger.error(`IOSAdapter ${this._id} getProtocolFor error: ${error}`);
            return new IOS9Protocol(target); // Safe fallback
        }
    }
}