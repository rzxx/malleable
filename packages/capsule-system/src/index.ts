import { Result, TaggedError } from "better-result";

type JsonRecord = Record<string, unknown>;

export type FileScope =
  | "explicit-path"
  | "full-filesystem"
  | "own-data"
  | "own-source"
  | "realm-files"
  | "user-picked-directory"
  | "user-picked-file";

export type CapabilityFamily = "commands" | "files" | "network" | "storage" | "system";

export type DirectoryEntry = {
  readonly kind: "directory" | "file" | "other";
  readonly name: string;
};

export type FileOptions = {
  readonly scope?: FileScope;
};

export type CommandResult = {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

export type NetworkResponse = {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
};

export type PermissionRequest =
  | {
      readonly access: readonly "run"[];
      readonly capability: "commands";
      readonly command?: string;
      readonly scope: "full-process" | "named-command" | "shell-command";
    }
  | {
      readonly access: readonly ("delete" | "read" | "write")[];
      readonly capability: "files";
      readonly path?: string;
      readonly scope: FileScope;
    }
  | {
      readonly access: readonly "connect"[];
      readonly capability: "network";
      readonly hosts?: readonly string[];
      readonly scope: "full-network" | "listed-hosts" | "private-network";
    }
  | {
      readonly access: readonly ("delete" | "read" | "write")[];
      readonly capability: "storage";
      readonly scope: "own-data" | "realm-data" | "shared-data";
    }
  | {
      readonly access: readonly ("read" | "run" | "write")[];
      readonly capability: "system";
      readonly scope:
        | "clipboard"
        | "dialogs"
        | "notifications"
        | "open-external-url"
        | "open-path"
        | "secrets";
    };

export type PermissionStatus = {
  readonly access: readonly string[];
  readonly capability: CapabilityFamily;
  readonly granted: true;
  readonly scope: Readonly<Record<string, unknown>>;
};

export class CapsuleTokenError extends TaggedError("CapsuleTokenError")<{
  message: string;
}>() {}

export class PermissionDeniedError extends TaggedError("PermissionDeniedError")<{
  capability?: string;
  inspectorUrl: string;
  message: string;
  operation?: string;
  reason: string;
  target?: string;
}>() {}

export class CapsuleRequestError extends TaggedError("CapsuleRequestError")<{
  code?: string;
  message: string;
  operation?: string;
  status: number;
}>() {}

export class CapsuleResponseError extends TaggedError("CapsuleResponseError")<{
  message: string;
}>() {}

export class CapsuleRuntimeError extends TaggedError("CapsuleRuntimeError")<{
  message: string;
}>() {}

export type CapsuleSystemError =
  | CapsuleRequestError
  | CapsuleResponseError
  | CapsuleRuntimeError
  | CapsuleTokenError
  | PermissionDeniedError;

export type SystemResult<TValue> = Result<TValue, CapsuleSystemError>;

type RequestBody = JsonRecord | readonly unknown[];

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(value: unknown): JsonRecord | undefined {
  return isJsonRecord(value) ? value : undefined;
}

function readString(source: JsonRecord, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.map(String)
    : undefined;
}

function readLaunchToken(): SystemResult<string> {
  const hash = new URLSearchParams(globalThis.location.hash.replace(/^#/, ""));
  const token = hash.get("malleableToken");
  if (!token) {
    return Result.err(
      new CapsuleTokenError({
        message: "Capsule launch token is missing"
      })
    );
  }

  return Result.ok(token);
}

function inspectorUrl(): string {
  return "/";
}

function requestErrorFromPayload(payload: unknown, status: number): CapsuleSystemError {
  const source = parseObject(payload);
  const message = readString(source ?? {}, "error") ?? `Capsule system request failed: ${status}`;
  const code = readString(source ?? {}, "code");
  const reason = readString(source ?? {}, "reason") ?? message;
  const operation = readString(source ?? {}, "operation");
  const capability = readString(source ?? {}, "capability");
  const target = readString(source ?? {}, "target");

  if (status === 403) {
    return new PermissionDeniedError({
      capability,
      inspectorUrl: inspectorUrl(),
      message,
      operation,
      reason,
      target
    });
  }

  return new CapsuleRequestError({
    code,
    message,
    operation,
    status
  });
}

async function requestJson(
  requestPath: string,
  options: {
    readonly body?: RequestBody;
    readonly method?: "DELETE" | "GET" | "POST" | "PUT";
  } = {}
): Promise<SystemResult<unknown>> {
  return await Result.gen(async function* () {
    const token = yield* readLaunchToken();
    const response = yield* Result.await(
      Result.tryPromise({
        catch: (cause) =>
          new CapsuleRuntimeError({
            message: cause instanceof Error ? cause.message : "Could not reach capsule daemon"
          }),
        try: async () =>
          await fetch(requestPath, {
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            method: options.method ?? "POST"
          })
      })
    );
    const payload = yield* Result.await(
      Result.tryPromise({
        catch: (cause) =>
          new CapsuleResponseError({
            message: cause instanceof Error ? cause.message : "Could not parse daemon response"
          }),
        try: async () => (await response.json()) as unknown
      })
    );

    if (!response.ok) {
      return Result.err(requestErrorFromPayload(payload, response.status));
    }

    return Result.ok(payload);
  });
}

function readStringPayload(payload: unknown, key: string): SystemResult<string> {
  const value = parseObject(payload)?.[key];
  if (typeof value !== "string") {
    return Result.err(
      new CapsuleResponseError({
        message: `System response did not include ${key}`
      })
    );
  }

  return Result.ok(value);
}

function readDirectoryEntries(payload: unknown): SystemResult<DirectoryEntry[]> {
  const entries = parseObject(payload)?.entries;
  if (!Array.isArray(entries)) {
    return Result.err(
      new CapsuleResponseError({
        message: "System response did not include directory entries"
      })
    );
  }

  const parsed: DirectoryEntry[] = [];
  for (const entry of entries) {
    const source = parseObject(entry);
    const kind = source?.kind;
    const name = source?.name;
    if ((kind !== "directory" && kind !== "file" && kind !== "other") || typeof name !== "string") {
      return Result.err(
        new CapsuleResponseError({
          message: "System response included an invalid directory entry"
        })
      );
    }

    parsed.push({
      kind,
      name
    });
  }

  return Result.ok(parsed);
}

function readCommandResult(payload: unknown): SystemResult<CommandResult> {
  const source = parseObject(payload);
  if (!source || typeof source.stdout !== "string" || typeof source.stderr !== "string") {
    return Result.err(
      new CapsuleResponseError({
        message: "System response did not include command output"
      })
    );
  }

  return Result.ok({
    code: typeof source.code === "number" ? source.code : null,
    stderr: source.stderr,
    stdout: source.stdout
  });
}

function readNetworkResponse(payload: unknown): SystemResult<NetworkResponse> {
  const source = parseObject(payload);
  const headers = parseObject(source?.headers);
  if (!source || typeof source.body !== "string" || typeof source.status !== "number" || !headers) {
    return Result.err(
      new CapsuleResponseError({
        message: "System response did not include network response data"
      })
    );
  }

  return Result.ok({
    body: source.body,
    headers: Object.fromEntries(
      Object.entries(headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    ),
    status: source.status
  });
}

function readPermissionStatus(payload: unknown): SystemResult<PermissionStatus> {
  const source = parseObject(payload);
  const permission = parseObject(source?.permission);
  const capability = permission?.capability;
  const scope = parseObject(permission?.scope);
  const access = readStringArray(permission?.access);
  if (
    !permission ||
    !scope ||
    !access ||
    typeof capability !== "string" ||
    (capability !== "commands" &&
      capability !== "files" &&
      capability !== "network" &&
      capability !== "storage" &&
      capability !== "system")
  ) {
    return Result.err(
      new CapsuleResponseError({
        message: "System response did not include permission status"
      })
    );
  }

  return Result.ok({
    access,
    capability,
    granted: true,
    scope
  });
}

function fileBody(filePath: string, options?: FileOptions): JsonRecord {
  return {
    path: filePath,
    scope: options?.scope
  };
}

function permissionBody(request: PermissionRequest): JsonRecord {
  return {
    ...request,
    access: [...request.access],
    hosts: "hosts" in request && request.hosts ? [...request.hosts] : undefined
  };
}

function describeError(error: CapsuleSystemError): string {
  if (PermissionDeniedError.is(error)) {
    return `${error.message}. Open Permissions in the shell to grant ${error.capability ?? "the requested capability"}.`;
  }

  return error.message;
}

async function withGrant<TValue, TError>(
  request: PermissionRequest,
  operation: () => Promise<Result<TValue, TError>>
): Promise<Result<TValue, CapsuleSystemError | TError>> {
  return await Result.gen(async function* () {
    yield* Result.await(system.permissions.ensure(request));
    const value = yield* Result.await(operation());
    return Result.ok(value);
  });
}

export const system = {
  Result,

  commands: {
    async run(command: string, args: readonly string[] = []): Promise<SystemResult<CommandResult>> {
      return await Result.gen(async function* () {
        const payload = yield* Result.await(
          requestJson("/api/capsule-system/commands/run", {
            body: {
              args: [...args],
              command
            }
          })
        );

        return readCommandResult(payload);
      });
    },

    async runShell(command: string): Promise<SystemResult<CommandResult>> {
      return await Result.gen(async function* () {
        const payload = yield* Result.await(
          requestJson("/api/capsule-system/commands/run", {
            body: {
              command,
              shell: true
            }
          })
        );

        return readCommandResult(payload);
      });
    }
  },

  files: {
    async deletePath(
      filePath: string,
      options?: FileOptions & { readonly recursive?: boolean }
    ): Promise<SystemResult<void>> {
      return await Result.gen(async function* () {
        yield* Result.await(
          requestJson("/api/capsule-system/files/delete-path", {
            body: {
              ...fileBody(filePath, options),
              recursive: options?.recursive === true
            }
          })
        );

        return Result.ok();
      });
    },

    async readDirectory(
      filePath = ".",
      options?: FileOptions
    ): Promise<SystemResult<DirectoryEntry[]>> {
      return await Result.gen(async function* () {
        const payload = yield* Result.await(
          requestJson("/api/capsule-system/files/read-directory", {
            body: fileBody(filePath, options)
          })
        );

        return readDirectoryEntries(payload);
      });
    },

    async readTextFile(filePath: string, options?: FileOptions): Promise<SystemResult<string>> {
      return await Result.gen(async function* () {
        const payload = yield* Result.await(
          requestJson("/api/capsule-system/files/read-text-file", {
            body: fileBody(filePath, options)
          })
        );

        return readStringPayload(payload, "text");
      });
    },

    async writeTextFile(
      filePath: string,
      text: string,
      options?: FileOptions
    ): Promise<SystemResult<void>> {
      return await Result.gen(async function* () {
        yield* Result.await(
          requestJson("/api/capsule-system/files/write-text-file", {
            body: {
              ...fileBody(filePath, options),
              text
            }
          })
        );

        return Result.ok();
      });
    }
  },

  isPermissionDenied(error: unknown): error is PermissionDeniedError {
    return PermissionDeniedError.is(error);
  },

  network: {
    async fetchText(
      url: string,
      init: { readonly body?: string; readonly method?: string } = {}
    ): Promise<SystemResult<NetworkResponse>> {
      return await Result.gen(async function* () {
        const payload = yield* Result.await(
          requestJson("/api/capsule-system/network/fetch", {
            body: {
              body: init.body,
              method: init.method,
              url
            }
          })
        );

        return readNetworkResponse(payload);
      });
    }
  },

  permissions: {
    describeError,

    async ensure(request: PermissionRequest): Promise<SystemResult<PermissionStatus>> {
      return await Result.gen(async function* () {
        const payload = yield* Result.await(
          requestJson("/api/capsule-system/permissions/ensure", {
            body: permissionBody(request)
          })
        );

        return readPermissionStatus(payload);
      });
    },

    withGrant
  },

  system: {
    async openExternalUrl(url: string): Promise<SystemResult<void>> {
      return await Result.gen(async function* () {
        yield* Result.await(
          requestJson("/api/capsule-system/system/open-external-url", {
            body: {
              url
            }
          })
        );

        return Result.ok();
      });
    },

    async openPath(targetPath: string): Promise<SystemResult<void>> {
      return await Result.gen(async function* () {
        yield* Result.await(
          requestJson("/api/capsule-system/system/open-path", {
            body: {
              path: targetPath
            }
          })
        );

        return Result.ok();
      });
    },

    secrets: {
      async get(key: string): Promise<SystemResult<string | undefined>> {
        return await Result.gen(async function* () {
          const payload = yield* Result.await(
            requestJson("/api/capsule-system/system/secrets/get", {
              body: {
                key
              }
            })
          );
          const value = parseObject(payload)?.value;
          return Result.ok(typeof value === "string" ? value : undefined);
        });
      },

      async set(key: string, value: string): Promise<SystemResult<void>> {
        return await Result.gen(async function* () {
          yield* Result.await(
            requestJson("/api/capsule-system/system/secrets/set", {
              body: {
                key,
                value
              }
            })
          );

          return Result.ok();
        });
      }
    }
  }
};
