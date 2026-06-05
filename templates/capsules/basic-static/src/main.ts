import {
  collection,
  createCapsuleStateClient,
  defineCapsuleState,
  schema,
  value
} from "@malleable/capsule-state";

const UsageSchema = schema.object({
  id: schema.string(),
  label: schema.string(),
  usedAt: schema.string()
});

const PreferencesSchema = schema.object({
  buttonLabel: schema.string()
});

const state = defineCapsuleState({
  stores: {
    preferences: value(PreferencesSchema, {
      defaultValue: {
        buttonLabel: "Use capsule"
      }
    }),
    usages: collection(UsageSchema, {
      id: "id",
      indexes: {
        byUsedAt: ["usedAt"]
      }
    })
  },
  version: 1
});

const capsuleName = "__MALLEABLE_CAPSULE_NAME__";
const capsuleDescription = "__MALLEABLE_CAPSULE_DESCRIPTION__";
const db = createCapsuleStateClient(state);
const preferencesStore = db.value(state.stores.preferences);
const usagesStore = db.collection(state.stores.usages);

const button = document.querySelector<HTMLButtonElement>("#action");
const result = document.querySelector<HTMLOutputElement>("#result");

if (!button || !result) {
  throw new Error("Capsule markup is missing required controls");
}

const actionButton = button;
const statusOutput = result;

async function render(): Promise<void> {
  const [preferences, usages] = await Promise.all([
    preferencesStore.get(),
    usagesStore.list({
      orderBy: {
        usedAt: "desc"
      }
    })
  ]);

  actionButton.textContent = preferences.buttonLabel;
  statusOutput.textContent =
    usages.length === 0
      ? capsuleDescription
      : `${capsuleName} has been used ${usages.length} time${usages.length === 1 ? "" : "s"}.`;
}

actionButton.addEventListener("click", () => {
  actionButton.disabled = true;
  void usagesStore
    .insert({
      id: crypto.randomUUID(),
      label: capsuleName,
      usedAt: new Date().toISOString()
    })
    .then(render)
    .catch((error: unknown) => {
      statusOutput.textContent =
        error instanceof Error ? error.message : "Could not save capsule state";
    })
    .finally(() => {
      actionButton.disabled = false;
    });
});

render().catch((error: unknown) => {
  statusOutput.textContent =
    error instanceof Error ? error.message : "Could not load capsule state";
});
