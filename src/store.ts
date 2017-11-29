
import * as debug from 'debug';
import * as admin from 'firebase-admin';
import { v4 } from 'uuid';
import { Schema } from './handlers/types';
import { Model, ModelOrPromise, ModelPromise } from './model';

const log: debug.IDebugger = debug('ninjafire:store');

const recordHandler: ProxyHandler<Model> = {
    get(target: Model, key: string, receiver: Model): {} {
        const schema: Schema = target.schema;
        if (schema.hasOwnProperty(key)) {
            return schema[key].handler(key).get(receiver);
        } else {
            return Reflect.get(target, key);
        }
    },
    set(target: Model, key: string, value: {}, receiver: Model): boolean {
        const schema: Schema = target.schema;
        if (schema[key]) {
            schema[key].handler(key).set(receiver, value, schema[key].handlingClass);
        } else {
            target[key] = value;
        }
        return true;
    },
    has(target: Model, key: string): boolean {
        return key in target.schema;
    },
};

export class Store {


    public basePath: string = '';
    public database: admin.database.Database;

    /**
     * A pathPrefix links a 'group' key to a path in the DB. eg 'team' : '/team/123456'
     * This prefix is then prefixed to the references for the model
     */
    public pathPrefix: { [group: string]: string } = {};

    // Whether to generate UUID id's or use 'push' style id's
    // The value is the version of UUID to generate
    public _useUUID: number | null = null;

    // Used by the store to store active records
    private _activeRecords: { [modelName: string]: { [id: string]: Model } } = {};

    /**
     * Initialize a store.
     * Optionally you can pass a 'basePath' to prefix all records in Firebase, effectively 'chroot'ing them.
     * By default id's will use the format generated by 'push()', optionally you can have UUIDv4 formatted id's
     * @param database A firebase database
     * @param options an object containing, optionally, basePath and useUUID
     */

    constructor(database: admin.database.Database, options: { basePath?: string, useUUID?: number } | null = null) {
        this.database = database;
        if (options !== null) {
            if (options.basePath !== undefined) {
                this.basePath = options.basePath;
            }
            if (options.useUUID !== undefined) {
                this._useUUID = options.useUUID;
            }
        }
        return this;
    }

    // tslint:disable-next-line:no-any
    public createRecord<T extends Model>(recordClass: { new(store: Store): T; }, data: { [key: string]: any }): T {

        // The constructor will automatically assign a v4 uuid if an id was not provided
        const record: T = new Proxy(new recordClass(this), recordHandler) as T;

        Object.keys(data).map((key: string) => {
            record[key] = data[key];
        });

        record.isValid = true;
        record.isNew = true;

        this.storeRecord(record);

        return record;
    }

    /**
     * Push existing data into the store
     * @param recordClass A subclass of Model
     * @param data The data to build the record from
     */
    // tslint:disable-next-line:no-any
    public pushRecord<T extends Model>(recordClass: { modelName?: string; new(store: Store): T; }, id: string, data: { [key: string]: any }): T {

        const storedRecord: T | null = this.retrieveStoredRecord(recordClass, id) as T | null;
        if (storedRecord !== null) {
            // A record exists in the store, update its data
            Object.keys(data).map((key: string) => {
                storedRecord[key] = data[key];
            });
            return storedRecord as T;
        }

        const record: T = new Proxy(new recordClass(this), recordHandler) as T;
        record.id = id;

        Object.keys(data).map((key: string) => {
            // Don't set 'id' attribute via the pushed data, it is supplied as an argument to this method
            if (key !== 'id') {
                record[key] = data[key];
            }
        });
        record.isValid = true;
        record.isNew = false;
        this.storeRecord(record);
        return record;
    }

    /**
     * Updates an existing record with the supplied data
     * @param record An existing record to update
     * @param data The data to update the existing record with
     */

    public pushRecordData(record: Model, data: {}): void {
        Object.keys(data).map((key: string) => {
            // Don't set 'id' attribute via the pushed data, it is an immutable property of the record
            if (key !== 'id') {
                record[key] = data[key];
            }
        });
    }

    public findRecord<T extends Model>(recordClass: { modelName?: string; new(store: Store, id: string): T; }, id: string): ModelOrPromise<T> {

        log(`going to find record with id: ${id}`);

        const storedRecord: T | null = this.retrieveStoredRecord(recordClass, id) as T | null;
        if (storedRecord !== null) {
            log(`returning existing record from store for id: ${id}`);
            return storedRecord as T;
        }

        log(`record not found for ${id} going to look it up`);
        const record: T = new recordClass(this, id);
        const wrappedRecord: T = new Proxy(record, recordHandler) as T; // Tell TS to treat the proxied record as having the type of the original model

        this.storeRecord(wrappedRecord);

        const loadingPromise: ModelPromise<T> = this._linkToFirebase(wrappedRecord) as ModelPromise<T>;
        Object.assign(loadingPromise, {
            id: wrappedRecord.id,
            _ref: wrappedRecord._ref,
            _path: wrappedRecord._path,
            isLoading: true,
        });
        wrappedRecord.loadingPromise = loadingPromise;
        return loadingPromise;
    }

    /**
     * Get a record by class and ID without triggering a request to Firebase. If the record is already loaded
     * it will be returned, otherwise null will be returned.
     * @param recordClass The class of the record to peek
     * @param id The id of the record to peek
     */

    public peekRecord<T extends Model>(recordClass: { modelName?: string; new(store: Store, id: string): T; }, id: string): T | null {

        log(`peeking for existing record ${id}`);

        const modelName: string | undefined = recordClass.modelName;

        if (modelName === undefined) {
            throw Error('modelName is not defined on class, cannot peek it');
        }

        if (this._activeRecords[modelName] !== undefined && this._activeRecords[modelName][id] !== undefined) {
            return this._activeRecords[modelName][id] as T;
        } else {
            return null;
        }

    }

    /**
     * Links a record to it's firebase reference, required when saving a newly created record, or for otherwise forcing a refresh
     * @param record The record to (re) link to firebase
     */

    public async _linkToFirebase(record: Model): Promise<{}> {

        // If the record is already has an active reference then stop listening to further updates
        if (record._ref !== undefined && record._ref !== null) {
            record._ref.off();
        }

        const path: string = record._path;
        log(`looking for record at path ${path}`);
        const ref: admin.database.Reference = this.database.ref(path);
        record._ref = ref;
        // tslint:disable-next-line:typedef
        return new Promise((resolve, reject) => {
            ref.on('value', (dataSnapshot: admin.database.DataSnapshot) => {

                log(`got data for ${record.id}`);

                // tslint:disable-next-line:no-any
                const result: any = dataSnapshot.val();
                if (this._activeRecords[record.modelName] !== undefined && this._activeRecords[record.modelName][record.id] !== undefined) {

                    if (result !== null) {
                        record.setAttributesFrom(result);
                    } else {
                        if (record.isDeleted) {
                            log('received null data for deleted record, ignore it');
                            resolve();
                        } else {
                            reject(`record not found for key ${ref.key}`);
                        }
                    }
                    record.loadingPromise = null;
                    record.isValid = true;
                    resolve(record);

                } else {
                    log(`ignoring data received form ${record.id} that is no longer an active record`);
                    resolve(record);
                }
            });


        });


    }
    /**
     * Unloads all records in the store, optionally supply a Model subclass which will remove all records of this type
     * @param {Model} [recordClass] Model to remove all records
     */
    public unloadAll<T extends Model>(recordClass: { modelName?: string; new(store: Store): T; } | null = null): void {
        // Create a record so we can get the model name
        if (recordClass !== null) {
            const modelName: string | undefined = recordClass.modelName;

            if (modelName === undefined) {
                throw Error('modelName is not defined on class, cannot unload it');
            }
            Object.keys(this._activeRecords[modelName]).map((id: string) => {
                this.unloadRecord(this._activeRecords[modelName][id]);
            }),
                delete this._activeRecords[modelName];
        } else {
            Object.keys(this._activeRecords).map((modelName: string) => {
                Object.keys(this._activeRecords[modelName]).map((id: string) => {
                    this.unloadRecord(this._activeRecords[modelName][id]);
                });
            });
            this._activeRecords = {};
        }
    }

    /**
     * Unloads the record from the store. This will cause the record to be destroyed and freed up for garbage collection.
     * @param {Model} record
     */

    public unloadRecord(record: Model): void {
        record._willUnload();
        delete this._activeRecords[record.modelName][record.id];
    }

    // tslint:disable-next-line:no-any
    public async _updatePaths(updates: { [path: string]: any }): Promise<void> {
        log('performing firebase updates');
        log(updates);
        try {
            await this.database.ref('/').update(updates);
        } catch (error) {
            console.error(`Failed to save updates: ${JSON.stringify(updates)} ${error} ${error.stack}`);
            throw error;
        }
    }
    
    /**
     * Saves all records that have pending changes atomically
     */

    public async saveAll(): Promise<void> {

        const recordsBeingSaved: Model[] = [];
        const updates = {};

        Object.keys(this._activeRecords).map((modelName: string) => {
            Object.keys(this._activeRecords[modelName]).map((id: string) => {
                const record = this._activeRecords[modelName][id];
                if (record.hasDirtyAttributes === true) {
                    record._willSave();
                    Object.assign(updates, record._pathsToSave());
                    recordsBeingSaved.push(record);
                }
            });
        });

        await this._updatePaths(updates);

        await Promise.all(recordsBeingSaved.map(async (savedRecord: Model) => {
            await savedRecord._didSave();
        }));

    }

    /**
     * Saves the record. Intended by be called from Model, rather than directly
     * Will also save records that are atomically linked
     * @param record The record to save
     */

    public async _save(record: Model): Promise<void> {

        const recordsToSave: Model[] = [record];
        const seenRecords: Model[] = [record];
        const updates = {};
        while (recordsToSave.length > 0) {

            const recordToSave: Model = recordsToSave[0]; // Could just shift here but typescript thinks it might be null if we do
            recordsToSave.shift();
            recordToSave._willSave();
            Object.assign(updates, recordToSave._pathsToSave());

            // Add atomically linked records to list of records to save
            recordToSave._atomicallyLinked.map((linkedRecord: Model) => {
                if (!seenRecords.includes(linkedRecord)) {
                    recordsToSave.push(linkedRecord);
                    seenRecords.push(linkedRecord);
                    linkedRecord._willSave();
                }
            });
        }
        await this._updatePaths(updates);

        await Promise.all(seenRecords.map(async (savedRecord: Model) => {
            await savedRecord._didSave();
        }));
    }

    /**
     * Stores a previously retrieved record in the local store.
     * @param {Model} record The record to store
     */

    private storeRecord(record: Model): void {
        const id: string = record.id;
        const modelName: string | undefined = record.modelName;

        if (modelName === undefined) {
            throw Error('modelName is not defined on class, cannot store it');
        }
        log(`going to store ${modelName}:${id}`);

        if (!(modelName in this._activeRecords)) {
            this._activeRecords[modelName] = {};
        }
        this._activeRecords[modelName][id] = record;
    }

    /**
     * Retrieve a record with an ID matching the supplied record. The original record will be returned if it exists, otherwise null
     * TODO: Rework this to take a model class and an id if possible
     * @param {Model} record A record, it should be initialized with the ID you want to match from the currently stored records
     */

    private retrieveStoredRecord<T extends Model>(recordClass: { modelName?: string; new(store: Store, id?: string): T; }, id: string): Model | null {

        const modelName: string | undefined = recordClass.modelName;

        if (modelName === undefined) {
            throw Error('modelName is not defined on class, cannot retrieve it from the store');
        }

        if (this._activeRecords[modelName] !== undefined && this._activeRecords[modelName][id] !== undefined) {
            return this._activeRecords[modelName][id];
        } else {
            return null;
        }
    }

}
