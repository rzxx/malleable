import {
  collection,
  createCapsuleStateClient,
  defineCapsuleState,
  schema,
  value
} from "@malleable/capsule-state";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

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

function App() {
  const [buttonLabel, setButtonLabel] = useState("Use capsule");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState(capsuleDescription);

  async function load() {
    const [preferences, usages] = await Promise.all([
      preferencesStore.get(),
      usagesStore.list({
        orderBy: {
          usedAt: "desc"
        }
      })
    ]);

    setButtonLabel(preferences.buttonLabel);
    setMessage(
      usages.length === 0
        ? capsuleDescription
        : `${capsuleName} has been used ${usages.length} time${usages.length === 1 ? "" : "s"}.`
    );
  }

  async function recordUse() {
    setIsSaving(true);
    try {
      await usagesStore.insert({
        id: crypto.randomUUID(),
        label: capsuleName,
        usedAt: new Date().toISOString()
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save capsule state");
    } finally {
      setIsSaving(false);
    }
  }

  useEffect(() => {
    load().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "Could not load capsule state");
    });
  }, []);

  return (
    <main className="tool">
      <section>
        <h1>{capsuleName}</h1>
        <p>{message}</p>
      </section>
      <button type="button" disabled={isSaving} onClick={() => void recordUse()}>
        {buttonLabel}
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
