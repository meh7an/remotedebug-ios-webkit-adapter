//
// Copyright (C) Microsoft. All rights reserved.
//

import * as request from 'request';
import * as http from 'http';
import * as WebSocket from 'ws';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { ITarget, IAdapterOptions } from './adapterInterfaces';
import { Target } from '../protocols/target';
import { Logger, debug } from '../logger';

export class Adapter extends EventEmitter {
    protected _id: string;
    protected _adapterType: string;
    protected _proxyUrl: string;
    protected _options: IAdapterOptions;
    protected _url: string;
    protected _proxyProc: ChildProcess;
    protected _targetMap: Map<string, Target>;
    protected _targetIdToTargetDataMap: Map<string, ITarget>;

    constructor(id: string, socket: string, options: IAdapterOptions) {
        super();

        this._id = id;
        this._proxyUrl = socket;
        this._targetMap = new Map<string, Target>();
        this._targetIdToTargetDataMap = new Map<string, ITarget>();

        // Apply default options with better safety checks
        options = options || {};
        options.pollingInterval = options.pollingInterval || 3000;
        options.baseUrl = options.baseUrl || 'http://127.0.0.1';
        options.path = options.path || '/json';
        options.port = options.port || 9222;
        this._options = options;

        this._url = `${this._options.baseUrl}:${this._options.port}${this._options.path}`;

        const index = this._id.indexOf('/', 1);
        if (index >= 0) {
            this._adapterType = '_' + this._id.substr(1, index - 1);
        } else {
            this._adapterType = this._id.replace('/', '_');
        }

        // Add global error handler for this adapter instance
        this.on('error', (error) => {
            Logger.error(`Adapter ${this._id} error: ${error}`);
        });
    }

    public get id(): string {
        debug(`adapter.id`);
        return this._id;
    }

    public async start(): Promise<any> {
        debug(`adapter.start`, this._options);

        try {
            if (!this._options.proxyExePath) {
                debug(`adapter.start: Skip spawnProcess, no proxyExePath available`);
                return Promise.resolve(`skipped`);
            }

            return await this.spawnProcess(this._options.proxyExePath, this._options.proxyExeArgs);
        } catch (error) {
            Logger.error(`Adapter ${this._id} start error: ${error}`);
            throw error; // Re-throw to let caller handle
        }
    }

    public stop(): void {
        debug(`adapter.stop`);
        try {
            if (this._proxyProc) {
                // Terminate the proxy process
                this._proxyProc.kill('SIGTERM');
                this._proxyProc = null;
            }
        } catch (error) {
            Logger.error(`Adapter ${this._id} stop error: ${error}`);
        }
    }

    public async getTargets(metadata?: any): Promise<ITarget[]> {
        debug(`adapter.getTargets, metadata=${JSON.stringify(metadata)}`);

        return new Promise((resolve, reject) => {
            // Add timeout to prevent hanging requests
            const timeoutId = setTimeout(() => {
                Logger.error(`Adapter ${this._id} getTargets timeout after 10 seconds`);
                resolve([]); // Return empty array instead of rejecting
            }, 10000);

            try {
                request(this._url, { timeout: 8000 }, (error: any, response: http.IncomingMessage, body: any) => {
                    clearTimeout(timeoutId);

                    if (error) {
                        Logger.error(`Adapter ${this._id} getTargets request error: ${error}`);
                        resolve([]); // Return empty array instead of rejecting
                        return;
                    }

                    if (!response) {
                        Logger.error(`Adapter ${this._id} getTargets: No response received`);
                        resolve([]);
                        return;
                    }

                    if (response.statusCode !== 200) {
                        Logger.error(`Adapter ${this._id} getTargets: HTTP ${response.statusCode}`);
                        resolve([]);
                        return;
                    }

                    if (!body) {
                        Logger.log(`Adapter ${this._id} getTargets: Empty response body`);
                        resolve([]);
                        return;
                    }

                    try {
                        const rawTargets: ITarget[] = JSON.parse(body);

                        if (!Array.isArray(rawTargets)) {
                            Logger.error(`Adapter ${this._id} getTargets: Response is not an array`);
                            resolve([]);
                            return;
                        }

                        const targets: ITarget[] = [];
                        rawTargets.forEach((t: ITarget) => {
                            try {
                                if (t && (t.id || t.webSocketDebuggerUrl)) {
                                    targets.push(this.setTargetInfo(t, metadata));
                                } else {
                                    Logger.log(`Adapter ${this._id} getTargets: Skipping invalid target: ${JSON.stringify(t)}`);
                                }
                            } catch (targetError) {
                                Logger.error(`Adapter ${this._id} getTargets: Error processing target: ${targetError}`);
                                // Continue processing other targets
                            }
                        });

                        resolve(targets);
                    } catch (parseError) {
                        Logger.error(`Adapter ${this._id} getTargets JSON parse error: ${parseError}`);
                        Logger.error(`Adapter ${this._id} getTargets response body: ${body}`);
                        resolve([]); // Return empty array instead of rejecting
                    }
                });
            } catch (requestError) {
                clearTimeout(timeoutId);
                Logger.error(`Adapter ${this._id} getTargets request setup error: ${requestError}`);
                resolve([]); // Return empty array instead of rejecting
            }
        });
    }

    public connectTo(targetId: string, wsFrom: WebSocket): Target | null {
        debug(`adapter.connectTo, targetId=${targetId}`);

        try {
            if (!targetId) {
                Logger.error(`Adapter ${this._id} connectTo: No targetId provided`);
                return null;
            }

            if (!wsFrom) {
                Logger.error(`Adapter ${this._id} connectTo: No WebSocket provided`);
                return null;
            }

            if (!this._targetIdToTargetDataMap.has(targetId)) {
                Logger.error(`Adapter ${this._id}: No endpoint url found for id ${targetId}`);
                return null;
            }

            if (this._targetMap.has(targetId)) {
                debug(`Existing target found for id ${targetId}`);
                const existingTarget = this._targetMap.get(targetId);
                if (existingTarget) {
                    existingTarget.updateClient(wsFrom);
                    return existingTarget;
                }
            }

            const targetData = this._targetIdToTargetDataMap.get(targetId);
            if (!targetData) {
                Logger.error(`Adapter ${this._id}: No target data found for id ${targetId}`);
                return null;
            }

            const target = new Target(targetId, targetData);

            // Add error handling for target connection
            target.on('error', (error) => {
                Logger.error(`Adapter ${this._id} target ${targetId} error: ${error}`);
                this.emit('targetError', { targetId, error });
            });

            target.connectTo(targetData.webSocketDebuggerUrl, wsFrom);

            // Store the tools websocket for this target
            this._targetMap.set(targetId, target);
            target.on('socketClosed', (id) => {
                try {
                    this.emit('socketClosed', id);
                } catch (error) {
                    Logger.error(`Adapter ${this._id} connectTo socketClosed event error: ${error}`);
                }
            });

            return target;
        } catch (error) {
            Logger.error(`Adapter ${this._id} connectTo error: ${error}`);
            return null;
        }
    }

    public forwardTo(targetId: string, message: string): void {
        debug(`adapter.forwardTo, targetId=${targetId}`);

        try {
            if (!targetId) {
                Logger.error(`Adapter ${this._id} forwardTo: No targetId provided`);
                return;
            }

            if (!message) {
                Logger.log(`Adapter ${this._id} forwardTo: Empty message`);
                return;
            }

            if (!this._targetMap.has(targetId)) {
                Logger.error(`Adapter ${this._id}: No target found for id ${targetId}`);
                return;
            }

            const target = this._targetMap.get(targetId);
            if (target) {
                target.forward(message);
            } else {
                Logger.error(`Adapter ${this._id}: Target ${targetId} is null or undefined`);
            }
        } catch (error) {
            Logger.error(`Adapter ${this._id} forwardTo error: ${error}`);
        }
    }

    public async forceRefresh(): Promise<void> {
        debug('adapter.forceRefresh');

        try {
            if (this._proxyProc && this._options.proxyExePath && this._options.proxyExeArgs) {
                await this.refreshProcess(this._proxyProc, this._options.proxyExePath, this._options.proxyExeArgs);
            } else {
                debug('adapter.forceRefresh: No proxy process to refresh');
            }
        } catch (error) {
            Logger.error(`Adapter ${this._id} forceRefresh error: ${error}`);
            // Don't throw - let the adapter continue running
        }
    }

    protected setTargetInfo(t: ITarget, metadata?: any): ITarget {
        debug('adapter.setTargetInfo', t, metadata);

        try {
            // Safety checks for target object
            if (!t) {
                throw new Error('Target is null or undefined');
            }

            // Ensure there is a valid id
            const id: string = (t.id || t.webSocketDebuggerUrl);
            if (!id) {
                throw new Error('Target has no id or webSocketDebuggerUrl');
            }

            t.id = id;

            // Set the adapter type
            t.adapterType = this._adapterType;
            t.type = t.type || 'page';

            // Append the metadata
            t.metadata = metadata;

            // Store the real endpoint with deep copy safety
            const targetData = this.safeDeepCopy(t);
            this._targetIdToTargetDataMap.set(t.id, targetData);

            // Overwrite the real endpoint with the url of our proxy multiplexor
            t.webSocketDebuggerUrl = `${this._proxyUrl}${this._id}/${t.id}`;
            let wsUrl = `${this._proxyUrl.replace('ws://', '')}${this._id}/${t.id}`;
            t.devtoolsFrontendUrl = `https://chrome-devtools-frontend.appspot.com/serve_file/@fcea73228632975e052eb90fcf6cd1752d3b42b4/inspector.html?experiments=true&remoteFrontend=screencast&ws=${wsUrl}`;

            return t;
        } catch (error) {
            Logger.error(`Adapter ${this._id} setTargetInfo error: ${error}`);
            // Return a minimal valid target to prevent crashes
            return {
                id: t?.id || 'unknown',
                adapterType: this._adapterType,
                type: 'page',
                metadata: metadata,
                webSocketDebuggerUrl: `${this._proxyUrl}${this._id}/unknown`,
                devtoolsFrontendUrl: '',
                description: t?.description || '',
                faviconUrl: t?.faviconUrl || '',
                title: t?.title || 'Unknown Target',
                url: t?.url || ''
            };
        }
    }

    protected async refreshProcess(process: ChildProcess, path: string, args: string[]): Promise<ChildProcess> {
        debug('adapter.refreshProcess');

        try {
            if (process) {
                process.kill('SIGTERM');
                // Give process time to terminate
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            return await this.spawnProcess(path, args);
        } catch (error) {
            Logger.error(`Adapter ${this._id} refreshProcess error: ${error}`);
            throw error;
        }
    }

    protected async spawnProcess(path: string, args: string[]): Promise<ChildProcess> {
        debug(`adapter.spawnProcess, path=${path}`);

        return new Promise((resolve, reject) => {
            try {
                if (this._proxyProc) {
                    reject(new Error('adapter.spawnProcess.error: process already started'));
                    return;
                }

                if (!path) {
                    reject(new Error('adapter.spawnProcess.error: no path provided'));
                    return;
                }

                args = args || [];

                this._proxyProc = spawn(path, args, {
                    detached: true,
                    stdio: ['ignore']
                });

                let processResolved = false;

                this._proxyProc.on('error', err => {
                    debug(`adapter.spawnProcess.error, err=${err}`);
                    if (!processResolved) {
                        processResolved = true;
                        reject(new Error(`adapter.spawnProcess.error: ${err}`));
                    }
                });

                this._proxyProc.on('close', (code) => {
                    debug(`adapter.spawnProcess.close, code=${code}`);
                    if (!processResolved) {
                        processResolved = true;
                        reject(new Error(`adapter.spawnProcess.close: code=${code}`));
                    }
                });

                this._proxyProc.on('exit', (code, signal) => {
                    debug(`adapter.spawnProcess.exit, code=${code}, signal=${signal}`);
                    if (!processResolved) {
                        processResolved = true;
                        reject(new Error(`adapter.spawnProcess.exit: code=${code}, signal=${signal}`));
                    }
                });

                if (this._proxyProc.stdout) {
                    this._proxyProc.stdout.on('data', data => {
                        debug(`adapter.spawnProcess.stdout, data=${data.toString()}`);
                    });
                }

                if (this._proxyProc.stderr) {
                    this._proxyProc.stderr.on('data', data => {
                        debug(`adapter.spawnProcess.stderr, data=${data.toString()}`);
                    });
                }

                // Give the process time to start up
                setTimeout(() => {
                    if (!processResolved) {
                        processResolved = true;
                        resolve(this._proxyProc);
                    }
                }, 200);

            } catch (spawnError) {
                Logger.error(`Adapter ${this._id} spawnProcess spawn error: ${spawnError}`);
                reject(spawnError);
            }
        });
    }

    // Helper method for safe deep copying
    private safeDeepCopy(obj: any): any {
        try {
            return JSON.parse(JSON.stringify(obj));
        } catch (error) {
            Logger.error(`Adapter ${this._id} safeDeepCopy error: ${error}`);
            return obj; // Return original if copy fails
        }
    }
}