import { Result, TaggedError } from "better-result";

type JsonRecord = Record<string, unknown>;

export type SortDirection = "asc" | "desc";

export class StateSchemaError extends TaggedError("StateSchemaError")<{
  message: string;
}>() {}

export type ParseResult<TValue> = Result<TValue, StateSchemaError>;

export type StateSchema<TValue> = {
  readonly optional: false;
  readonly parse: (value: unknown) => ParseResult<TValue>;
};

export type OptionalStateSchema<TValue> = {
  readonly optional: true;
  readonly parse: (value: unknown) => ParseResult<TValue | undefined>;
};

export type AnyStateSchema = OptionalStateSchema<unknown> | StateSchema<unknown>;

type ObjectShape = Record<string, AnyStateSchema>;

type InferSchema<TSchema extends AnyStateSchema> = TSchema extends
  | OptionalStateSchema<infer TValue>
  | StateSchema<infer TValue>
  ? TValue
  : never;

type OptionalShapeKeys<TShape extends ObjectShape> = {
  [TKey in keyof TShape]: TShape[TKey] extends OptionalStateSchema<unknown> ? TKey : never;
}[keyof TShape];

type RequiredShapeKeys<TShape extends ObjectShape> = Exclude<
  keyof TShape,
  OptionalShapeKeys<TShape>
>;

type InferObject<TShape extends ObjectShape> = {
  readonly [TKey in RequiredShapeKeys<TShape>]: InferSchema<TShape[TKey]>;
} & {
  readonly [TKey in OptionalShapeKeys<TShape>]?: InferSchema<TShape[TKey]>;
};

export type RecordIdKey<TRecord extends JsonRecord> = {
  [TKey in keyof TRecord]: TRecord[TKey] extends string ? TKey : never;
}[keyof TRecord] &
  string;

export type CollectionDefinition<
  TRecord extends JsonRecord,
  TIdKey extends keyof TRecord & string
> = {
  readonly idKey: TIdKey;
  readonly indexes: Readonly<Record<string, readonly (keyof TRecord & string)[]>>;
  readonly kind: "collection";
  readonly schema: StateSchema<TRecord>;
};

export type ValueDefinition<TValue> = {
  readonly defaultValue?: TValue;
  readonly kind: "value";
  readonly schema: StateSchema<TValue>;
};

export type AnyCollectionDefinition = {
  readonly idKey: string;
  readonly indexes: Readonly<Record<string, readonly string[]>>;
  readonly kind: "collection";
  readonly schema: StateSchema<JsonRecord>;
};

export type StoreDefinition = AnyCollectionDefinition | ValueDefinition<unknown>;

export type StateDefinition<TStores extends Record<string, StoreDefinition>> = {
  readonly stores: TStores;
  readonly version: number;
};

export type CollectionListOptions<TRecord extends JsonRecord> = {
  readonly limit?: number;
  readonly orderBy?: Partial<Record<keyof TRecord & string, SortDirection>>;
  readonly where?: Partial<TRecord>;
};

export type CollectionClient<TRecord extends JsonRecord, TIdKey extends keyof TRecord & string> = {
  readonly get: (id: string) => Promise<TRecord | undefined>;
  readonly insert: (record: TRecord) => Promise<TRecord>;
  readonly list: (options?: CollectionListOptions<TRecord>) => Promise<TRecord[]>;
  readonly remove: (id: string) => Promise<void>;
  readonly update: (id: string, patch: Partial<Omit<TRecord, TIdKey>>) => Promise<TRecord>;
  readonly upsert: (record: TRecord) => Promise<TRecord>;
};

export type ValueClient<TValue> = {
  readonly get: () => Promise<TValue>;
  readonly set: (value: TValue) => Promise<TValue>;
};

export type CapsuleStateClient = {
  readonly collection: <TRecord extends JsonRecord, TIdKey extends keyof TRecord & string>(
    definition: CollectionDefinition<TRecord, TIdKey>
  ) => CollectionClient<TRecord, TIdKey>;
  readonly value: <TValue>(definition: ValueDefinition<TValue>) => ValueClient<TValue>;
};

function ok<TValue>(value: TValue): ParseResult<TValue> {
  return Result.ok(value);
}

function fail(message: string): ParseResult<never> {
  return Result.err(new StateSchemaError({ message }));
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(value: unknown): JsonRecord | undefined {
  return isJsonRecord(value) ? value : undefined;
}

function requireResult<TValue>(result: ParseResult<TValue>, label: string): TValue {
  if (Result.isOk(result)) {
    return result.value;
  }

  throw new Error(`${label}: ${result.error.message}`);
}

function buildSchema<TValue>(parse: (value: unknown) => ParseResult<TValue>): StateSchema<TValue> {
  return {
    optional: false,
    parse
  };
}

function readOptionalResult(
  schema: AnyStateSchema,
  source: JsonRecord,
  key: string
): ParseResult<unknown> {
  if (!(key in source) && schema.optional) {
    return ok(undefined);
  }

  return schema.parse(source[key]);
}

function matchesObjectShape<TShape extends ObjectShape>(
  source: unknown,
  shape: TShape
): source is InferObject<TShape> {
  const record = parseObject(source);
  if (!record) {
    return false;
  }

  for (const [key, childSchema] of Object.entries(shape)) {
    if (Result.isError(readOptionalResult(childSchema, record, key))) {
      return false;
    }
  }

  return true;
}

function matchesUnion<TSchemas extends readonly StateSchema<unknown>[]>(
  source: unknown,
  schemas: TSchemas
): source is InferSchema<TSchemas[number]> {
  return schemas.some((candidate) => Result.isOk(candidate.parse(source)));
}

export const schema = {
  array<TItem>(itemSchema: StateSchema<TItem>): StateSchema<TItem[]> {
    return buildSchema((value) => {
      if (!Array.isArray(value)) {
        return fail("expected array");
      }

      const parsed: TItem[] = [];
      for (const item of value) {
        const result = itemSchema.parse(item);
        if (Result.isError(result)) {
          return result;
        }
        parsed.push(result.value);
      }

      return ok(parsed);
    });
  },

  boolean(): StateSchema<boolean> {
    return buildSchema((value) =>
      typeof value === "boolean" ? ok(value) : fail("expected boolean")
    );
  },

  literal<const TValue extends boolean | number | string>(expected: TValue): StateSchema<TValue> {
    return buildSchema((value) =>
      value === expected ? ok(expected) : fail(`expected ${String(expected)}`)
    );
  },

  nullable<TValue>(inner: StateSchema<TValue>): StateSchema<TValue | null> {
    return buildSchema((value) => (value === null ? ok(null) : inner.parse(value)));
  },

  number(): StateSchema<number> {
    return buildSchema((value) =>
      typeof value === "number" && Number.isFinite(value)
        ? ok(value)
        : fail("expected finite number")
    );
  },

  object<TShape extends ObjectShape>(shape: TShape): StateSchema<InferObject<TShape>> {
    return buildSchema((value) => {
      if (!matchesObjectShape(value, shape)) {
        return fail("expected object");
      }

      return ok(value);
    });
  },

  optional<TValue>(inner: StateSchema<TValue>): OptionalStateSchema<TValue> {
    return {
      optional: true,
      parse(value) {
        return value === undefined ? ok(undefined) : inner.parse(value);
      }
    };
  },

  string(): StateSchema<string> {
    return buildSchema((value) =>
      typeof value === "string" ? ok(value) : fail("expected string")
    );
  },

  union<const TSchemas extends readonly StateSchema<unknown>[]>(
    schemas: TSchemas
  ): StateSchema<InferSchema<TSchemas[number]>> {
    return buildSchema((value) => {
      if (matchesUnion(value, schemas)) {
        return ok(value);
      }

      return fail("did not match any union member");
    });
  }
};

export function collection<TRecord extends JsonRecord, TIdKey extends RecordIdKey<TRecord>>(
  recordSchema: StateSchema<TRecord>,
  options: {
    readonly id: TIdKey;
    readonly indexes?: Readonly<Record<string, readonly (keyof TRecord & string)[]>>;
  }
): CollectionDefinition<TRecord, TIdKey> {
  return {
    idKey: options.id,
    indexes: options.indexes ?? {},
    kind: "collection",
    schema: recordSchema
  };
}

const storeNames = new WeakMap<StoreDefinition, string>();

function stateValue<TValue>(
  valueSchema: StateSchema<TValue>,
  options?: {
    readonly defaultValue?: TValue;
  }
): ValueDefinition<TValue> {
  return {
    defaultValue: options?.defaultValue,
    kind: "value",
    schema: valueSchema
  };
}

export { stateValue as value };

export function defineCapsuleState<TStores extends Record<string, StoreDefinition>>(definition: {
  readonly stores: TStores;
  readonly version: number;
}): StateDefinition<TStores> {
  for (const [storeName, storeDefinition] of Object.entries(definition.stores)) {
    storeNames.set(storeDefinition, storeName);
  }

  return definition;
}

function readStoreName(definition: StoreDefinition): string {
  const storeName = storeNames.get(definition);
  if (!storeName) {
    throw new Error("State store definition was not registered");
  }

  return storeName;
}

type RequestBody = JsonRecord | readonly unknown[];

type RecordPayload = {
  readonly record: unknown;
};

type RecordsPayload = {
  readonly records: readonly unknown[];
};

type ValuePayload = {
  readonly value: unknown;
};

function readLaunchToken(): string {
  const hash = new URLSearchParams(globalThis.location.hash.replace(/^#/, ""));
  const token = hash.get("malleableToken");
  if (!token) {
    throw new Error("Capsule state token is missing");
  }

  return token;
}

async function requestJson(
  path: string,
  options: {
    readonly body?: RequestBody;
    readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    readonly token: string;
  }
): Promise<unknown> {
  const response = await fetch(path, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json"
    },
    method: options.method
  });
  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    const error = parseObject(payload)?.error;
    throw new Error(typeof error === "string" ? error : `State request failed: ${response.status}`);
  }

  return payload;
}

function readRecordPayload(payload: unknown): RecordPayload {
  const source = parseObject(payload);
  if (!source || !("record" in source)) {
    throw new Error("State response did not include a record");
  }

  return {
    record: source.record
  };
}

function readRecordsPayload(payload: unknown): RecordsPayload {
  const source = parseObject(payload);
  const records = source?.records;
  if (!Array.isArray(records)) {
    throw new Error("State response did not include records");
  }

  return {
    records
  };
}

function readOptionalRecordPayload(payload: unknown): Partial<RecordPayload> {
  const source = parseObject(payload);
  if (!source || !("record" in source)) {
    return {};
  }

  return {
    record: source.record
  };
}

function readValuePayload(payload: unknown): Partial<ValuePayload> {
  const source = parseObject(payload);
  if (!source || !("value" in source)) {
    return {};
  }

  return {
    value: source.value
  };
}

function recordsPath(storeName: string): string {
  return `/api/capsule-state/stores/${encodeURIComponent(storeName)}/records`;
}

function recordPath(storeName: string, id: string): string {
  return `${recordsPath(storeName)}/${encodeURIComponent(id)}`;
}

function valuePath(storeName: string): string {
  return `/api/capsule-state/stores/${encodeURIComponent(storeName)}/value`;
}

function matchesWhere<TRecord extends JsonRecord>(
  record: TRecord,
  where: Partial<TRecord>
): boolean {
  return Object.entries(where).every(([key, expected]) => Object.is(record[key], expected));
}

function sortRecords<TRecord extends JsonRecord>(
  records: TRecord[],
  orderBy: Partial<Record<keyof TRecord & string, SortDirection>>
): TRecord[] {
  const entries = Object.entries(orderBy);
  if (entries.length === 0) {
    return records;
  }

  return records.toSorted((left, right) => {
    for (const [key, direction] of entries) {
      const leftValue = left[key];
      const rightValue = right[key];
      if (leftValue === rightValue) {
        continue;
      }

      const result = String(leftValue).localeCompare(String(rightValue));
      return direction === "desc" ? -result : result;
    }

    return 0;
  });
}

function createCollectionClient<TRecord extends JsonRecord, TIdKey extends keyof TRecord & string>(
  storeName: string,
  definition: CollectionDefinition<TRecord, TIdKey>,
  token: string
): CollectionClient<TRecord, TIdKey> {
  function readId(record: TRecord): string {
    const id = record[definition.idKey];
    if (typeof id !== "string") {
      throw new Error(`${storeName}: record id must be a string`);
    }

    return id;
  }

  return {
    async get(id) {
      const payload = readOptionalRecordPayload(
        await requestJson(recordPath(storeName, id), {
          method: "GET",
          token
        })
      );

      return payload.record === undefined
        ? undefined
        : requireResult(definition.schema.parse(payload.record), storeName);
    },

    async insert(record) {
      const parsed = requireResult(definition.schema.parse(record), storeName);
      const payload = readRecordPayload(
        await requestJson(recordsPath(storeName), {
          body: {
            id: readId(parsed),
            record: parsed
          },
          method: "POST",
          token
        })
      );

      return requireResult(definition.schema.parse(payload.record), storeName);
    },

    async list(options = {}) {
      const payload = readRecordsPayload(
        await requestJson(recordsPath(storeName), {
          method: "GET",
          token
        })
      );
      let records = payload.records.map((record) =>
        requireResult(definition.schema.parse(record), storeName)
      );

      if (options.where) {
        records = records.filter((record) => matchesWhere(record, options.where ?? {}));
      }

      if (options.orderBy) {
        records = sortRecords(records, options.orderBy);
      }

      return options.limit === undefined ? records : records.slice(0, options.limit);
    },

    async remove(id) {
      await requestJson(recordPath(storeName, id), {
        method: "DELETE",
        token
      });
    },

    async update(id, patch) {
      const current = await this.get(id);
      if (!current) {
        throw new Error(`Record not found: ${id}`);
      }

      const next = requireResult(definition.schema.parse({ ...current, ...patch }), storeName);
      const payload = readRecordPayload(
        await requestJson(recordPath(storeName, id), {
          body: {
            record: next
          },
          method: "PATCH",
          token
        })
      );

      return requireResult(definition.schema.parse(payload.record), storeName);
    },

    async upsert(record) {
      const parsed = requireResult(definition.schema.parse(record), storeName);
      const payload = readRecordPayload(
        await requestJson(recordPath(storeName, readId(parsed)), {
          body: {
            record: parsed
          },
          method: "PUT",
          token
        })
      );

      return requireResult(definition.schema.parse(payload.record), storeName);
    }
  };
}

function createValueClient<TValue>(
  storeName: string,
  definition: ValueDefinition<TValue>,
  token: string
): ValueClient<TValue> {
  return {
    async get() {
      const payload = readValuePayload(
        await requestJson(valuePath(storeName), {
          method: "GET",
          token
        })
      );

      if (payload.value === undefined && "defaultValue" in definition) {
        return requireResult(definition.schema.parse(definition.defaultValue), storeName);
      }

      return requireResult(definition.schema.parse(payload.value), storeName);
    },

    async set(nextValue) {
      const parsed = requireResult(definition.schema.parse(nextValue), storeName);
      const payload = readValuePayload(
        await requestJson(valuePath(storeName), {
          body: {
            value: parsed
          },
          method: "PUT",
          token
        })
      );

      return requireResult(definition.schema.parse(payload.value), storeName);
    }
  };
}

export function createCapsuleStateClient(
  _state: StateDefinition<Record<string, StoreDefinition>>
): CapsuleStateClient {
  const token = readLaunchToken();

  return {
    collection(definition) {
      return createCollectionClient(readStoreName(definition), definition, token);
    },
    value(definition) {
      return createValueClient(readStoreName(definition), definition, token);
    }
  };
}
