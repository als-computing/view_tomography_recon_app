/**
 * main.jsx
 *
 * Entry point for the Vite + React application. Renders the <App /> component.
 */

// Must be first: sets window.__TILED_BASE_URL__ before the @blueskyproject/tiled widget module
// evaluates (its patched Jv() reads it for the auth/refresh base URL).
import './tiledBaseUrlGlobal'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './index.css'

// One QueryClient for the app's server state (Tiled folder/ESAF lists).
const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')).render(
    <QueryClientProvider client={queryClient}>
        <App />
    </QueryClientProvider>
)