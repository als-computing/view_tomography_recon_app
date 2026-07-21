/**
 * main.jsx
 *
 * Entry point for the Vite + React application. Renders the <App /> component.
 */

// Must be first: sets window.__TILED_BASE_URL__ before the @blueskyproject/tiled widget module
// evaluates (its patched Jv() reads it for the auth/refresh base URL).
import './tiledBaseUrlGlobal'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
)