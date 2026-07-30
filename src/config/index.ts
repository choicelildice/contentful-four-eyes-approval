/**
 * App configuration screen (vanilla, no framework).
 *
 * Sole job: let an admin set the `approvedStepId` installation parameter — the
 * stepId of the Workflow's "Approved" step that the Function enforces against.
 * Kept dependency-light (plain @contentful/app-sdk) since it's a single field.
 */
import { init, type AppExtensionSDK } from '@contentful/app-sdk';

init((sdk) => {
  const app = (sdk as AppExtensionSDK).app;
  const root = document.getElementById('root')!;

  root.innerHTML = `
    <main style="font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; color: #111b2b;">
      <h1 style="font-size: 1.4rem;">Four-Eyes Approval</h1>
      <p style="color:#5a657c; line-height:1.5;">
        Enter the <strong>stepId</strong> of your Workflow's <em>Approved</em> step. When an entry
        reaches this step, the app checks that the approver did not contribute to the entry, and
        reverts the step if they did.
      </p>
      <label style="display:block; font-weight:600; margin:1.5rem 0 .4rem;">Approved stepId</label>
      <input id="approvedStepId" type="text" placeholder="e.g. 4Xh7c0Rk2..."
        style="width:100%; padding:.6rem .7rem; border:1px solid #cfd9e0; border-radius:6px; font-size:1rem;" />
      <p style="color:#8a94a6; font-size:.85rem; margin-top:.5rem;">
        Find it via the CMA: GET /spaces/{space}/environments/{env}/workflow_definitions →
        your workflow → steps → the "Approved" step's <code>id</code>.
      </p>
    </main>
  `;

  const input = document.getElementById('approvedStepId') as HTMLInputElement;

  // Pre-fill from existing saved parameters.
  app.getParameters().then((params: Record<string, unknown> | null) => {
    if (params && typeof params.approvedStepId === 'string') {
      input.value = params.approvedStepId;
    }
    app.setReady();
  });

  // Called when the admin clicks "Install"/"Save" in the Contentful UI.
  app.onConfigure(() => {
    return {
      parameters: { approvedStepId: input.value.trim() },
    };
  });
});
