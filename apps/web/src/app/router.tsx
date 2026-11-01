import { lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { AppLayout } from './Layout.tsx';
import { AcceptInvitePage, LoginPage, SignupPage } from './AuthPages.tsx';
import { NotFound, RouteError } from './RouteError.tsx';
const HomePage = lazy(() => import('../features/dashboard/HomePage.tsx').then((m) => ({ default: m.HomePage })));
import { DealsPage } from '../features/deals/DealsPage.tsx';
import { DealDetail } from '../features/deals/DealDetail.tsx';
import { LeadsPage } from '../features/leads/LeadsPage.tsx';
import { LeadDetail } from '../features/leads/LeadDetail.tsx';
import { ContactsPage } from '../features/contacts/ContactsPage.tsx';
import { ContactDetail } from '../features/contacts/ContactDetail.tsx';
import { CompaniesPage } from '../features/companies/CompaniesPage.tsx';
import { CompanyDetail } from '../features/companies/CompanyDetail.tsx';
import { ProductsPage } from '../features/products/ProductsPage.tsx';
import { ActivitiesPage } from '../features/activities/ActivitiesPage.tsx';
const ReportsPage = lazy(() => import('../features/reports/ReportsPage.tsx').then((m) => ({ default: m.ReportsPage })));
import { SettingsLayout } from '../features/settings/SettingsLayout.tsx';
import { WorkspaceSettings } from '../features/settings/WorkspaceSettings.tsx';
import { PipelinesSettings } from '../features/settings/PipelinesSettings.tsx';
import { FieldsSettings } from '../features/settings/FieldsSettings.tsx';
import { DictionariesSettings } from '../features/settings/DictionariesSettings.tsx';
import { UsersSettings } from '../features/settings/UsersSettings.tsx';
import { RolesSettings } from '../features/settings/RolesSettings.tsx';
import { AutomationSettings } from '../features/settings/AutomationSettings.tsx';
import { RecycleBin } from '../features/settings/RecycleBin.tsx';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  { path: '/invite/:token', element: <AcceptInvitePage /> },
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'leads', element: <LeadsPage /> },
      { path: 'leads/:id', element: <LeadDetail /> },
      { path: 'deals', element: <DealsPage /> },
      { path: 'deals/:id', element: <DealDetail /> },
      { path: 'contacts', element: <ContactsPage /> },
      { path: 'contacts/:id', element: <ContactDetail /> },
      { path: 'companies', element: <CompaniesPage /> },
      { path: 'companies/:id', element: <CompanyDetail /> },
      { path: 'products', element: <ProductsPage /> },
      { path: 'activities', element: <ActivitiesPage /> },
      { path: 'reports', element: <ReportsPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Navigate to="workspace" replace /> },
          { path: 'workspace', element: <WorkspaceSettings /> },
          { path: 'pipelines', element: <PipelinesSettings /> },
          { path: 'fields', element: <FieldsSettings /> },
          { path: 'lists', element: <DictionariesSettings /> },
          { path: 'users', element: <UsersSettings /> },
          { path: 'roles', element: <RolesSettings /> },
          { path: 'automation', element: <AutomationSettings /> },
          { path: 'recycle-bin', element: <RecycleBin /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
