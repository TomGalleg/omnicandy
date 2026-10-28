// "Open a blank document": start a program, show it inside OmniCandy and leave a new empty document open, using only commands the
// adapters already have. Used by the Software tab's "Open in OmniCandy" button and by Claude through the command app.open_blank.

export const OPEN_BLANK = 'app.open_blank';
export const OPEN_BLANK_DESCRIPTION = 'Starts the program (you approve it), shows it inside OmniCandy and opens a new blank document, scene or project in it. Use this when the person asks to open the program or start something new in it.';

type Params = Record<string, string | number | boolean>;
export type RunStep = (command: string, params: Params) => Promise<unknown>;

/** Adapters that have an app.open_blank. */
export const BLANK_ADAPTERS = ['blender', 'unreal', 'resolve', 'autodesk.fusion'] as const;
export const hasOpenBlank = (adapterId: string | null | undefined): boolean => !!adapterId && (BLANK_ADAPTERS as readonly string[]).includes(adapterId);

const stamp = (): string => new Date().toISOString().replace(/\D/g, '').slice(2, 12);

const FUSION_NEW_DOCUMENT = JSON.stringify({
  purpose: 'Open a new empty design in Fusion',
  code: "def run(_context):\n    app = adsk.core.Application.get()\n    app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)\n    print('A new empty design is open.')",
  readOnly: false,
});

/** Runs the steps for one adapter; resolves with a plain sentence for the person. Throws only when the program itself could not be started. */
export async function openBlank(adapterId: string, name: string, run: RunStep): Promise<string> {
  switch (adapterId) {
    case 'blender': {
      const file = `Untitled-${stamp()}.blend`;
      await run('scene.create_basic', { file_name: file });
      await run('scene.open_window', { file_name: file });
      return `Blender is open inside OmniCandy on a new scene (${file}).`;
    }
    case 'unreal': {
      const project = `OmniCandy_Blank_${stamp()}`;
      await run('project.create', { name: project, template: 'blank' });
      try {
        await run('editor.launch', { project });
      } catch (e) {
        // an editor that is already open serves OmniCandy: show it instead of starting a second one
        await run('editor.show', {}).catch(() => { throw e; });
        return 'An Unreal editor was already open, so it is shown inside OmniCandy. The new blank project was created and can be opened later.';
      }
      return `Unreal Editor is open inside OmniCandy on a new Blank project (${project}).`;
    }
    case 'resolve': {
      await run('app.launch', {});
      try {
        await run('project.create_scratch', { name: 'Blank', with_timeline: true });
      } catch {
        return `${name} is open inside OmniCandy, but a blank project could not be made from here (Resolve needs External scripting on, or the OmniCandy Resolve Bridge script running). Use File > New Project in Resolve.`;
      }
      return `${name} is open inside OmniCandy with a new blank project and an empty timeline.`;
    }
    case 'autodesk.fusion': {
      await run('app.launch', {});
      try {
        await run('script.run', { script: FUSION_NEW_DOCUMENT });
      } catch {
        return `${name} is open inside OmniCandy, but the new blank design was not made (the approval was declined or Fusion was busy). Use File > New Design in Fusion.`;
      }
      return `${name} is open inside OmniCandy with a new empty design.`;
    }
    default:
      throw new Error(`${name} has no blank-document start yet.`);
  }
}
