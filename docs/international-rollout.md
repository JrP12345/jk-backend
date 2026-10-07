# Country rollout status

The organization country is a legal and operating context. A branch may override
the organization timezone. Existing organizations keep their stored values and
have no country code until an administrator reviews them; country must not be
inferred from a city name, phone number, or currency.

| Country code | Country | Location currency | Organization timezone |
| --- | --- | --- | --- |
| IN | India | INR | Asia/Kolkata |
| US | United States | USD | Explicit selection required |
| CA | Canada | CAD | Explicit selection required |
| GB | United Kingdom, including London | GBP | Europe/London |
| AE | United Arab Emirates | AED | Asia/Dubai |

The country is fixed after it is set. Changing a live organization's legal
country needs a reviewed data and billing migration. Branch timezone may change
independently. Appointment slots, booking dates, daily tokens, and public QR
queue joining use the location's local calendar. Public and staff appointment
entry converts location local times to UTC before sending them to the API.

Indian phone identities retain their historical ten-digit storage format.
International phone entry requires an explicit `+` country code and is stored
with that prefix. Before a broad rollout, inspect existing user and patient
phone records for ambiguous international numbers and duplicate identities.
Verify the deployed OTP/SMS/WhatsApp provider's delivery and template coverage
for each destination country; accepting a number in the form does not certify
provider delivery.

Invoice records now snapshot the organization currency. India-only Razorpay
checkout and UPI collection reject other country/currency contexts. Manual
invoice creation, encounter charge capture, and consolidated checkout also
reject foreign locations while they still calculate Indian GST. A simple
consultation invoice may be created with a foreign booking, and its amount is
stored in the location currency. Do not enable mandatory online prepayment for
a foreign location. Till reports and some receipt views still assume rupees.
Each country needs its tax and payment workflow reviewed before production
billing is enabled there. The existing SaaS subscription currency is separate
from a location's patient invoice currency.

The repository already runs lint, type checks, tests, build, dependency audit,
and backend release auditing in CI. Production frontend images now require an
explicit non-localhost API URL at build time. Use the existing deployment
readiness endpoint in `DEPLOYMENT.md` for releases and the release/rollback
checklist in [the cross-verification report](pre-production-cleanup.md).
