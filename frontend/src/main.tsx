import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './shell';
import './styles.css';

if (!/^\/anonymous\/?$/.test(window.location.pathname)) {
  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400..800&family=Unbounded:wght@500;600&display=swap';
  document.head.append(fonts);
}

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 15000, retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}>
  <BrowserRouter><App /></BrowserRouter>
</QueryClientProvider></React.StrictMode>);
