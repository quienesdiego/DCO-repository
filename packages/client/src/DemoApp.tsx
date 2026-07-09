// DCOView is a verbatim port — no props. It reads its backend URL from
// VITE_API_URL (see .env.example) and the logged-in user's email from
// localStorage key "muse_user", exactly like the source MUSE frontend did.
import { DCOView } from './DCOView.js';

export default function DemoApp() {
  return <DCOView />;
}
