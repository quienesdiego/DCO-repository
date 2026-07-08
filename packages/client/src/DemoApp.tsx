// Minimal example of hosting DCOStudio inside your own app. Replace the props
// below with your real backend URL, auth, brand color, and logged-in user.
import DCOStudio from './DCOStudio.js';

export default function DemoApp() {
  return (
    <DCOStudio
      apiBaseUrl={import.meta.env.VITE_DCO_API_URL || 'http://localhost:3001'}
      apiKeyHeader={
        import.meta.env.VITE_DCO_API_SECRET
          ? { name: 'X-Api-Key', value: import.meta.env.VITE_DCO_API_SECRET }
          : undefined
      }
      brandColor="#2563EB"
      currentUserEmail="demo@example.com"
    />
  );
}
