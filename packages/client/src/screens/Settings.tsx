import type { Me } from '../api';
import { ToolPage } from '../ui/night';
import { SettingsPanel } from '../ui/settings';

/** The player's Settings outside the game (from the account menu). */
export function SettingsPage({ me }: { me: Me }) {
  return (
    <ToolPage me={me} className="narrow">
      <h1 className="h1">Settings</h1>
      <div className="panel settings-page">
        <div className="panel-body">
          <SettingsPanel />
        </div>
      </div>
    </ToolPage>
  );
}
