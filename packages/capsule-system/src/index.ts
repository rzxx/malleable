type JsonRecord = Record<string, unknown>;

export type FileScope =
  | "explicit-path"
  | "full-filesystem"
  | "own-data"
  | "own-source"
  | "realm-files"
  | "user-picked-directory"
  | "user-picked-file";

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

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(value: unknown): JsonRecord | undefined {
  return isJsonRecord(value) ? value : undefined;
}

function readLaunchToken(): string {
  const hash = new URLSearchParams(globalThis.location.hash.replace(/^#/, ""));
  const token = hash.get("malleableToken");
  if (!token) {
    throw new Error("Capsule launch token is missing");
  }

  return token;
}

async function requestJson(
  path: string,
  options: {
    readonly body?: JsonRecord;
    readonly method?: "DELETE" | "GET" | "POST" | "PUT";
  } = {}
): Promise<unknown> {
  const response = await fetch(path, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Authorization: `Bearer ${readLaunchToken()}`,
      "Content-Type": "application/json"
    },
    method: options.method ?? "POST"
  });
  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    const error = parseObject(payload)?.error;
    throw new Error(
      typeof error === "string" ? error : `Capsule system request failed: ${response.status}`
    );
  }

  return payload;
}

function readStringPayload(payload: unknown, key: string): string {
  const value = parseObject(payload)?.[key];
  if (typeof value !== "string") {
    throw new Error(`System response did not include ${key}`);
  }

  return value;
}

function readDirectoryEntries(payload: unknown): DirectoryEntry[] {
  const entries = parseObject(payload)?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("System response did not include directory entries");
  }

  return entries.map((entry) => {
    const source = parseObject(entry);
    const kind = source?.kind;
    const name = source?.name;
    if ((kind !== "directory" && kind !== "file" && kind !== "other") || typeof name !== "string") {
      throw new Error("System response included an invalid directory entry");
    }

    return {
      kind,
      name
    };
  });
}

function readCommandResult(payload: unknown): CommandResult {
  const source = parseObject(payload);
  if (!source || typeof source.stdout !== "string" || typeof source.stderr !== "string") {
    throw new Error("System response did not include command output");
  }

  return {
    code: typeof source.code === "number" ? source.code : null,
    stderr: source.stderr,
    stdout: source.stdout
  };
}

function readNetworkResponse(payload: unknown): NetworkResponse {
  const source = parseObject(payload);
  const headers = parseObject(source?.headers);
  if (!source || typeof source.body !== "string" || typeof source.status !== "number" || !headers) {
    throw new Error("System response did not include network response data");
  }

  return {
    body: source.body,
    headers: Object.fromEntries(
      Object.entries(headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    ),
    status: source.status
  };
}

function fileBody(filePath: string, options?: FileOptions): JsonRecord {
  return {
    path: filePath,
    scope: options?.scope
  };
}

export const system = {
  commands: {
    async run(command: string, args: readonly string[] = []): Promise<CommandResult> {
      return readCommandResult(
        await requestJson("/api/capsule-system/commands/run", {
          body: {
            args: [...args],
            command
          }
        })
      );
    },

    async runShell(command: string): Promise<CommandResult> {
      return readCommandResult(
        await requestJson("/api/capsule-system/commands/run", {
          body: {
            command,
            shell: true
          }
        })
      );
    }
  },

  files: {
    async deletePath(filePath: string, options?: FileOptions & { readonly recursive?: boolean }) {
      await requestJson("/api/capsule-system/files/delete-path", {
        body: {
          ...fileBody(filePath, options),
          recursive: options?.recursive === true
        }
      });
    },

    async readDirectory(filePath = ".", options?: FileOptions): Promise<DirectoryEntry[]> {
      return readDirectoryEntries(
        await requestJson("/api/capsule-system/files/read-directory", {
          body: fileBody(filePath, options)
        })
      );
    },

    async readTextFile(filePath: string, options?: FileOptions): Promise<string> {
      return readStringPayload(
        await requestJson("/api/capsule-system/files/read-text-file", {
          body: fileBody(filePath, options)
        }),
        "text"
      );
    },

    async writeTextFile(filePath: string, text: string, options?: FileOptions): Promise<void> {
      await requestJson("/api/capsule-system/files/write-text-file", {
        body: {
          ...fileBody(filePath, options),
          text
        }
      });
    }
  },

  network: {
    async fetchText(url: string, init: { readonly body?: string; readonly method?: string } = {}) {
      return readNetworkResponse(
        await requestJson("/api/capsule-system/network/fetch", {
          body: {
            body: init.body,
            method: init.method,
            url
          }
        })
      );
    }
  },

  system: {
    async openExternalUrl(url: string): Promise<void> {
      await requestJson("/api/capsule-system/system/open-external-url", {
        body: {
          url
        }
      });
    },

    async openPath(targetPath: string): Promise<void> {
      await requestJson("/api/capsule-system/system/open-path", {
        body: {
          path: targetPath
        }
      });
    },

    secrets: {
      async get(key: string): Promise<string | undefined> {
        const payload = await requestJson("/api/capsule-system/system/secrets/get", {
          body: {
            key
          }
        });
        const value = parseObject(payload)?.value;
        return typeof value === "string" ? value : undefined;
      },

      async set(key: string, value: string): Promise<void> {
        await requestJson("/api/capsule-system/system/secrets/set", {
          body: {
            key,
            value
          }
        });
      }
    }
  }
};
