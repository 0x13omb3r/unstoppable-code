// Billing (AI Credits) settings: the page modules the hosted page registry
// loads, the shared sections web routes render, the payment area, and the
// slots a web host fills with its inline financial UI. Deliberately narrow:
// nothing here imports Stripe, `@canopy/ui-app/billing` payment forms, charts
// or the financial editors, which stay in the web app.
export { AccountBillingPage } from './AccountBillingPage';
export { AccountInvoicePage } from './AccountInvoicePage';
export { OrganizationInvoicePage } from './OrganizationInvoicePage';
export { BillingSection } from './account-billing-section';
export { TeamBillingSection } from './team-billing-section';
export {
  InvoiceDetailPage,
  type InvoiceDetailPageProps,
} from './invoice-detail-page';
export {
  InvoicesSection,
  INVOICES_PAGE_LIMIT,
  type InvoicesSectionProps,
} from './invoices-section';
export {
  PaymentArea,
  PaymentAreaCta,
  PaymentAreaNotice,
  PAYMENT_HANDOFF_BROWSER_FAILED_COPY,
  PAYMENT_HANDOFF_FAILED_COPY,
  PAYMENT_HANDOFF_UNAVAILABLE_COPY,
  PAYMENT_HANDOFF_OPENED_COPY,
  paymentAreaActionLabel,
  paymentAreaHandoffIntent,
  paymentCaptureAvailable,
  paymentOwnerBillingPath,
  usePaymentAreaMode,
  type PaymentAreaAction,
  type PaymentAreaCtaProps,
  type PaymentAreaMode,
  type PaymentAreaProps,
} from './PaymentArea';
export {
  BillingSettingsSlotsProvider,
  useBillingSettingsSlots,
  type AutoTopUpControlsSlotProps,
  type BillingIntentControllerSlotProps,
  type BillingSettingsIntentTarget,
  type BillingSettingsSlots,
  type CreditPoolSubscriptionSlotProps,
  type CreditsTopUpParts,
  type CreditsTopUpSlotProps,
  type OrganizationPaymentMethodActionsParts,
  type OrganizationPaymentMethodActionsSlotProps,
  type PersonalPaymentMethodActionsSlotProps,
} from './billing-settings-slots';
export {
  AutoTopUpSettingsDetails,
  AutoTopUpSummary,
  autoTopUpEffectiveTuning,
  autoTopUpToggleSentence,
} from './auto-top-up-summary';
export { BillingTogglePanel } from './billing-toggle-panel';
export { CreditsUsedThisPeriod } from './credits-used-this-period';
