//
// Copyright (C) Microsoft. All rights reserved.
//

import * as fs from 'fs';
import { Adapter } from './adapter';
import * as path from 'path';
import { Logger, debug } from '../logger';
import { ITarget } from './adapterInterfaces';

export class TestAdapter extends Adapter {
    private _jsonPath: string;

    constructor(id: string, proxyUrl: string) {
        super(id, proxyUrl, {});
        this._jsonPath = path.join(__dirname, '../../src/lib/test-targets.json');

        // Add error handler for this test adapter instance
        this.on('error', (error) => {
            Logger.error(`TestAdapter ${this._id} error: ${error}`);
        });
    }

    public async getTargets(): Promise<ITarget[]> {
        debug(`TestAdapter ${this._id} getTargets`);

        try {
            const count = 10;

            // Validate that the JSON file path exists
            if (!this._jsonPath) {
                Logger.error(`TestAdapter ${this._id} getTargets: No JSON path configured`);
                return [];
            }

            // Check if file exists before trying to read it
            if (!await this.fileExists(this._jsonPath)) {
                Logger.error(`TestAdapter ${this._id} getTargets: JSON file does not exist at ${this._jsonPath}`);
                return [];
            }

            const data = await this.readJsonFile(this._jsonPath);
            if (!data) {
                Logger.error(`TestAdapter ${this._id} getTargets: Failed to read JSON file`);
                return [];
            }

            const rawTargets = this.parseJsonData(data);
            if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
                Logger.error(`TestAdapter ${this._id} getTargets: Invalid or empty targets array`);
                return [];
            }

            const targets = this.createTestTargets(rawTargets, count);
            return targets;

        } catch (error) {
            Logger.error(`TestAdapter ${this._id} getTargets error: ${error}`);
            return [];
        }
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    private async readJsonFile(filePath: string): Promise<string | null> {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                Logger.error(`TestAdapter ${this._id} readJsonFile timeout after 5 seconds`);
                resolve(null);
            }, 5000);

            try {
                fs.readFile(filePath, 'utf8', (error: any, data: string) => {
                    clearTimeout(timeoutId);

                    if (error) {
                        Logger.error(`TestAdapter ${this._id} readJsonFile error: ${error}`);
                        resolve(null);
                        return;
                    }

                    if (!data || typeof data !== 'string') {
                        Logger.error(`TestAdapter ${this._id} readJsonFile: Invalid data received`);
                        resolve(null);
                        return;
                    }

                    resolve(data);
                });
            } catch (readError) {
                clearTimeout(timeoutId);
                Logger.error(`TestAdapter ${this._id} readJsonFile setup error: ${readError}`);
                resolve(null);
            }
        });
    }

    private parseJsonData(data: string): ITarget[] | null {
        try {
            if (!data || data.trim().length === 0) {
                Logger.error(`TestAdapter ${this._id} parseJsonData: Empty data string`);
                return null;
            }

            const parsed = JSON.parse(data);

            if (!Array.isArray(parsed)) {
                Logger.error(`TestAdapter ${this._id} parseJsonData: Parsed data is not an array`);
                return null;
            }

            return parsed as ITarget[];
        } catch (parseError) {
            Logger.error(`TestAdapter ${this._id} parseJsonData error: ${parseError}`);
            Logger.error(`TestAdapter ${this._id} parseJsonData data preview: ${data.substring(0, 100)}...`);
            return null;
        }
    }

    private createTestTargets(rawTargets: ITarget[], count: number): ITarget[] {
        try {
            if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
                Logger.error(`TestAdapter ${this._id} createTestTargets: Invalid rawTargets array`);
                return [];
            }

            if (typeof count !== 'number' || count <= 0) {
                Logger.error(`TestAdapter ${this._id} createTestTargets: Invalid count: ${count}`);
                count = 1; // Default to at least 1 target
            }

            const targets: ITarget[] = [];

            for (let i = 0; i < count; i++) {
                try {
                    // Select target with proper bounds checking
                    const sourceIndex = i < rawTargets.length ? i : 0;
                    const sourceTarget = rawTargets[sourceIndex];

                    if (!sourceTarget) {
                        Logger.error(`TestAdapter ${this._id} createTestTargets: Source target at index ${sourceIndex} is null`);
                        continue;
                    }

                    // Create a copy to avoid modifying the original
                    const targetCopy = this.safeDeepCopyTarget(sourceTarget);
                    if (!targetCopy) {
                        Logger.error(`TestAdapter ${this._id} createTestTargets: Failed to copy target at index ${sourceIndex}`);
                        continue;
                    }

                    // Ensure the target has a unique ID for testing
                    targetCopy.id = targetCopy.id ? `${targetCopy.id}_test_${i}` : `test_target_${i}`;

                    const processedTarget = this.setTargetInfo(targetCopy);
                    if (processedTarget) {
                        targets.push(processedTarget);
                    } else {
                        Logger.error(`TestAdapter ${this._id} createTestTargets: Failed to process target ${i}`);
                    }
                } catch (targetError) {
                    Logger.error(`TestAdapter ${this._id} createTestTargets target ${i} error: ${targetError}`);
                    // Continue processing other targets
                }
            }

            Logger.log(`TestAdapter ${this._id} createTestTargets: Created ${targets.length} test targets`);
            return targets;
        } catch (error) {
            Logger.error(`TestAdapter ${this._id} createTestTargets error: ${error}`);
            return [];
        }
    }

    // Helper method for safe deep copying
    private safeDeepCopyTarget(obj: any): any {
        try {
            if (!obj) {
                return null;
            }
            return JSON.parse(JSON.stringify(obj));
        } catch (error) {
            Logger.error(`TestAdapter ${this._id} safeDeepCopyTarget error: ${error}`);
            return obj; // Return original if copy fails
        }
    }
}