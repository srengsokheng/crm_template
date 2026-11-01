import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { queryClient } from './lib/api.ts';
import { router } from './app/router.tsx';
import { applyTheme, getTheme } from './app/theme.ts';
import './styles.css';

applyTheme(getTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ duration: 4000 }} />
    </QueryClientProvider>
  </StrictMode>,
);
