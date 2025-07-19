//
// Copyright (C) Microsoft. All rights reserved.
//

import * as WebSocket from 'ws';
import { ITarget, IAdapterOptions } from './adapterInterfaces';
import { Adapter } from './adapter';
import { Target } from '../protocols/target';
import { Logger, debug } from '../logger';

export class AdapterCollection extends Adapter {
    protected _adapters: Map<string, Adapter>;

    constructor(id: string, proxyUrl: string, options: IAdapterOptions) {
        super(id, proxyUrl, options);
        this._adapters = new Map<string, Adapter>();
    }

    public async start(): Promise<any> {
        debug(`adapterCollection.start`, this._adapters);

        try {
            const startPromises = [super.start()];

            this._adapters.forEach((adapter, adapterId) => {
                try {
                    startPromises.push(adapter.start());
                } catch (error) {
                    Logger.error(`AdapterCollection ${this._id} failed to start adapter ${adapterId}: ${error}`);
                    // Continue with other adapters
                }
            });

            const results = await Promise.allSettled(startPromises);

            // Log any failures but don't throw
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    Logger.error(`AdapterCollection ${this._id} start promise ${index} rejected: ${result.reason}`);
                }
            });

            return results;
        } catch (error) {
            Logger.error(`AdapterCollection ${this._id} start error: ${error}`);
            throw error;
        }
    }

    public stop(): void {
        debug(`adapterCollection.stop`);

        try {
            super.stop();
        } catch (error) {
            Logger.error(`AdapterCollection ${this._id} stop super error: ${error}`);
        }

        this._adapters.forEach((adapter, adapterId) => {
            try {
                if (adapter && typeof adapter.stop === 'function') {
                    adapter.stop();
                }
            } catch (error) {
                Logger.error(`AdapterCollection ${this._id} failed to stop adapter ${adapterId}: ${error}`);
            }
        });
    }

    public async forceRefresh(): Promise<void> {
        debug(`adapterCollection.forceRefresh`);

        try {
            await super.forceRefresh();
        } catch (error) {
            Logger.error(`AdapterCollection ${this._id} forceRefresh super error: ${error}`);
        }

        const refreshPromises: Promise<void>[] = [];

        this._adapters.forEach((adapter, adapterId) => {
            try {
                if (adapter && typeof adapter.forceRefresh === 'function') {
                    refreshPromises.push(
                        Promise.resolve(adapter.forceRefresh()).catch((error) => {
                            Logger.error(`AdapterCollection ${this._id} failed to refresh adapter ${adapterId}: ${error}`);
                        })
                    );
                }
            } catch (error) {
                Logger.error(`AdapterCollection ${this._id} forceRefresh adapter ${adapterId} error: ${error}`);
            }
        });

        if (refreshPromises.length > 0) {
            try {
                await Promise.allSettled(refreshPromises);
            } catch (error) {
                Logger.error(`AdapterCollection ${this._id} forceRefresh Promise.allSettled error: ${error}`);
            }
        }
    }

    public async getTargets(metadata?: any): Promise<ITarget[]> {
        try {
            const promises: Promise<ITarget[]>[] = [];
            let index = 0;

            this._adapters.forEach((adapter, adapterId) => {
                try {
                    if (!adapter || typeof adapter.getTargets !== 'function') {
                        Logger.error(`AdapterCollection ${this._id} invalid adapter ${adapterId}`);
                        return;
                    }

                    let targetMetadata = null;
                    if (metadata) {
                        try {
                            targetMetadata = (Array.isArray(metadata) ? metadata[index] : metadata);
                        } catch (metadataError) {
                            Logger.error(`AdapterCollection ${this._id} metadata processing error: ${metadataError}`);
                            targetMetadata = null;
                        }
                    }

                    // Wrap each adapter's getTargets in a safe promise
                    const safeGetTargets = adapter.getTargets(targetMetadata)
                        .catch((error) => {
                            Logger.error(`AdapterCollection ${this._id} adapter ${adapterId} getTargets error: ${error}`);
                            return []; // Return empty array on error
                        });

                    promises.push(safeGetTargets);
                    index++;
                } catch (error) {
                    Logger.error(`AdapterCollection ${this._id} error processing adapter ${adapterId}: ${error}`);
                }
            });

            if (promises.length === 0) {
                Logger.log(`AdapterCollection ${this._id} getTargets: No valid adapters found`);
                return [];
            }

            try {
                const results: ITarget[][] = await Promise.all(promises);

                let allTargets: ITarget[] = [];
                results.forEach((targets, resultIndex) => {
                    try {
                        if (Array.isArray(targets)) {
                            allTargets = allTargets.concat(targets);
                        } else {
                            Logger.error(`AdapterCollection ${this._id} getTargets result ${resultIndex} is not an array: ${JSON.stringify(targets)}`);
                        }
                    } catch (concatError) {
                        Logger.error(`AdapterCollection ${this._id} error concatenating targets from result ${resultIndex}: ${concatError}`);
                    }
                });

                return allTargets;
            } catch (promiseAllError) {
                Logger.error(`AdapterCollection ${this._id} Promise.all error: ${promiseAllError}`);
                return [];
            }
        } catch (error) {
            Logger.error(`AdapterCollection ${this._id} getTargets error: ${error}`);
            return [];
        }
    }

    public connectTo(url: string, wsFrom: WebSocket): Target | null {
        debug(`adapterCollection.connectTo, url=${url}`);

        try {
            if (!url) {
                Logger.error(`AdapterCollection ${this._id} connectTo: No URL provided`);
                return null;
            }

            if (!wsFrom) {
                Logger.error(`AdapterCollection ${this._id} connectTo: No WebSocket provided`);
                return null;
            }

            const id = this.getWebSocketId(url);
            if (!id || !id.adapterId || !id.targetId) {
                Logger.error(`AdapterCollection ${this._id} connectTo: Invalid WebSocket ID parsed from URL ${url}`);
                return null;
            }

            let target: Target | null = null;

            if (this._adapters.has(id.adapterId)) {
                const adapter = this._adapters.get(id.adapterId);
                if (adapter && typeof adapter.connectTo === 'function') {
                    try {
                        target = adapter.connectTo(id.targetId, wsFrom);
                    } catch (connectError) {
                        Logger.error(`AdapterCollection ${this._id} adapter ${id.adapterId} connectTo error: ${connectError}`);
                        return null;
                    }
                } else {
                    Logger.error(`AdapterCollection ${this._id} adapter ${id.adapterId} is invalid or missing connectTo method`);
                }
            } else {
                Logger.error(`AdapterCollection ${this._id} adapter ${id.adapterId} not found`);
            }

            return target;
        } catch (error) {
            Logger.error(`AdapterCollection ${this._id} connectTo error: ${error}`);
            return null;
        }
    }

    public forwardTo(url: string, message: string): void {
        debug(`adapterCollection.forwardTo, url=${url}`);

        try {
            if (!url) {
                Logger.error(`AdapterCollection ${this._id} forwardTo: No URL provided`);
                return;
            }

            if (!message) {
                Logger.log(`AdapterCollection ${this._id} forwardTo: Empty message for URL ${url}`);
                return;
            }

            const id = this.getWebSocketId(url);
            if (!id || !id.adapterId || !id.targetId) {
                Logger.error(`AdapterCollection ${this._id} forwardTo: Invalid WebSocket ID parsed from URL ${url}`);
                return;
            }

            if (this._adapters.has(id.adapterId)) {
                const adapter = this._adapters.get(id.adapterId);
                if (adapter && typeof adapter.forwardTo === 'function') {
                    try {
                        adapter.forwardTo(id.targetId, message);
                    } catch (forwardError) {
                        Logger.error(`AdapterCollection ${this._id} adapter ${id.adapterId} forwardTo error: ${forwardError}`);
                    }
                } else {
                    Logger.error(`AdapterCollection ${this._id} adapter ${id.adapterId} is invalid or missing forwardTo method`);
                }
            } else {
                Logger.error(`AdapterCollection ${this._id} adapter ${id.adapterId} not found`);
            }
        } catch (error) {
            Logger.error(`AdapterCollection ${this._id} forwardTo error: ${error}`);
        }
    }

    private getWebSocketId(url: string): { adapterId: string, targetId: string } | null {
        debug(`adapterCollection.getWebSocketId, url=${url}`);

        try {
            if (!url || typeof url !== 'string') {
                Logger.error(`AdapterCollection ${this._id} getWebSocketId: Invalid URL: ${url}`);
                return null;
            }

            const index = url.indexOf('/', 1);
            if (index === -1) {
                Logger.error(`AdapterCollection ${this._id} getWebSocketId: No separator found in URL: ${url}`);
                return null;
            }

            const adapterId = url.substr(0, index);
            const targetId = url.substr(index + 1);

            if (!adapterId || !targetId) {
                Logger.error(`AdapterCollection ${this._id} getWebSocketId: Empty adapterId or targetId from URL: ${url}`);
                return null;
            }

            return { adapterId: adapterId, targetId: targetId };
        } catch (error) {
            Logger.error(`AdapterCollection ${this._id} getWebSocketId error: ${error}`);
            return null;
        }
    }
}