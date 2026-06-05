import {
  collection,
  createCapsuleStateClient,
  defineCapsuleState,
  schema,
  value
} from "@malleable/capsule-state";

import "./styles.css";

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

const capsuleName = __MALLEABLE_CAPSULE_NAME_JSON__;
const capsuleDescription = __MALLEABLE_CAPSULE_DESCRIPTION_JSON__;
const db = createCapsuleStateClient(state);
const preferencesStore = db.value(state.stores.preferences);
const usagesStore = db.collection(state.stores.usages);

document.querySelector<HTMLDivElement>("#root")!.innerHTML = `
  <main class="tool">
    <section>
      <h1></h1>
      <p></p>
    </section>
    <button type="button"></button>
  </main>
`;

const title = document.querySelector<HTMLHeadingElement>("h1")!;
const message = document.querySelector<HTMLParagraphElement>("p")!;
const button = document.querySelector<HTMLButtonElement>("button")!;

title.textContent = capsuleName;

async function render(): Promise<void> {
  const [preferences, usages] = await Promise.all([
    preferencesStore.get(),
    usagesStore.list({
      orderBy: {
        usedAt: "desc"
      }
    })
  ]);

  button.textContent = preferences.buttonLabel;
  message.textContent =
    usages.length === 0
      ? capsuleDescription
      : `${capsuleName} has been used ${usages.length} time${usages.length === 1 ? "" : "s"}.`;
}

button.addEventListener("click", () => {
  button.disabled = true;
  void usagesStore
    .insert({
      id: crypto.randomUUID(),
      label: capsuleName,
      usedAt: new Date().toISOString()
    })
    .then(render)
    .catch((error: unknown) => {
      message.textContent = error instanceof Error ? error.message : "Could not save capsule state";
    })
    .finally(() => {
      button.disabled = false;
    });
});

render().catch((error: unknown) => {
  message.textContent = error instanceof Error ? error.message : "Could not load capsule state";
});
