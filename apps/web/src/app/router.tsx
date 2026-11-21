import { lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { AppLayout } from './Layout.tsx';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage, ConfirmEmailPage } from './AuthPages.tsx';
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
import { CalendarPage } from '../features/activities/CalendarPage.tsx';
import { ComponentsPage } from '../features/dev/ComponentsPage.tsx';
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
import { AuditLog } from '../features/settings/AuditLog.tsx';
import { CurrenciesSettings } from '../features/settings/CurrenciesSettings.tsx';
import { DocumentPage } from '../features/documents/DocumentPage.tsx';
import { DocumentsPage } from '../features/documents/DocumentsPage.tsx';
import { DocumentSettings } from '../features/settings/DocumentSettings.tsx';
import { ImportStart } from '../features/imports/ImportStart.tsx';
import { ImportDetail } from '../features/imports/ImportDetail.tsx';
import { DuplicatesPage } from '../features/duplicates/DuplicatesPage.tsx';
import { InboxPage } from '../features/inbox/InboxPage.tsx';
import { CallPage, GuestCallPage } from '../features/calls/CallPages.tsx';
import { TargetsSettings } from '../features/targets/Targets.tsx';
import { CustomerDocumentPage } from '../features/documents/CustomerPage.tsx';
import { BroadcastRoute, BroadcastsPage, UnsubscribePage } from '../features/broadcasts/Broadcasts.tsx';
import { ManageBookingPage, PublicBookingPage } from '../features/booking/PublicBooking.tsx';
import { BookingSettings } from '../features/booking/BookingSettings.tsx';
import { FeedbackSettings, RatePage } from '../features/feedback/Feedback.tsx';
import { ChannelsSettings } from '../features/settings/ChannelsSettings.tsx';
import { AccountSettings } from '../features/settings/AccountSettings.tsx';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  { path: '/invite/:token', element: <AcceptInvitePage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password/:token', element: <ResetPasswordPage /> },
  { path: '/confirm-email/:token', element: <ConfirmEmailPage /> },
  { path: '/join/:token', element: <GuestCallPage /> },
  { path: '/d/:token', element: <CustomerDocumentPage /> },
  { path: '/unsubscribe/:token', element: <UnsubscribePage /> },
  { path: '/book/:slug', element: <PublicBookingPage /> },
  { path: '/booking/:token', element: <ManageBookingPage /> },
  { path: '/r/:token', element: <RatePage /> },
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
      { path: 'calls/:id', element: <CallPage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'inbox/:id', element: <InboxPage /> },
      { path: 'broadcasts', element: <BroadcastsPage /> },
      { path: 'broadcasts/new', element: <BroadcastRoute /> },
      { path: 'broadcasts/:id', element: <BroadcastRoute /> },
      { path: 'documents', element: <DocumentsPage /> },
      { path: 'documents/:id', element: <DocumentPage /> },
      { path: 'contacts', element: <ContactsPage /> },
      { path: 'contacts/:id', element: <ContactDetail /> },
      { path: 'companies', element: <CompaniesPage /> },
      { path: 'companies/:id', element: <CompanyDetail /> },
      { path: 'products', element: <ProductsPage /> },
      { path: 'activities', element: <ActivitiesPage /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'dev/components', element: <ComponentsPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'import/:entity', element: <ImportStart /> },
      { path: 'imports/:id', element: <ImportDetail /> },
      { path: 'duplicates/:entity', element: <DuplicatesPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Navigate to="account" replace /> },
          { path: 'account', element: <AccountSettings /> },
          { path: 'workspace', element: <WorkspaceSettings /> },
          { path: 'pipelines', element: <PipelinesSettings /> },
          { path: 'fields', element: <FieldsSettings /> },
          { path: 'lists', element: <DictionariesSettings /> },
          { path: 'users', element: <UsersSettings /> },
          { path: 'roles', element: <RolesSettings /> },
          { path: 'automation', element: <AutomationSettings /> },
          { path: 'audit-log', element: <AuditLog /> },
          { path: 'currencies', element: <CurrenciesSettings /> },
          { path: 'documents', element: <DocumentSettings /> },
          { path: 'targets', element: <TargetsSettings /> },
          { path: 'booking', element: <BookingSettings /> },
          { path: 'feedback', element: <FeedbackSettings /> },
          { path: 'channels', element: <ChannelsSettings /> },
          { path: 'recycle-bin', element: <RecycleBin /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
