import React from 'react';
import { Info, AlertTriangle } from 'lucide-react';

/**
 * Privacy policy and terms of service.
 *
 * These are reachable at #privacy and #terms and are linked from the footer. Both are written
 * to be accurate rather than boilerplate: where the product does something a user would care
 * about, it says so plainly instead of hiding behind a template.
 */

const LegalLayout = ({ kicker, title, updated, intro, tone = 'info', sections }) => (
  <div className="w-full">
    <div className="w-full bg-gray-50/50 border-b border-[#e6e8ec]">
      <div className="container mx-auto max-w-5xl px-6 py-16 space-y-6">
        <p className="text-sm font-bold uppercase tracking-widest text-[#6b7280]">{kicker}</p>
        <h1 className="text-[36px] md:text-[44px] font-bold tracking-tighter leading-tight">{title}</h1>
        <p className="text-[15px] text-[#6b7280]">Last updated {updated}.</p>
        <div
          className={
            tone === 'warn'
              ? 'p-5 rounded-[16px] flex gap-3 items-start bg-[#fdf9f0] border border-[#ecd9ab]'
              : 'p-6 bg-white border border-[#e6e8ec] rounded-[16px] flex gap-4 shadow-sm'
          }
        >
          {tone === 'warn' ? (
            <AlertTriangle className="h-6 w-6 shrink-0 mt-0.5" />
          ) : (
            <Info className="h-6 w-6 shrink-0 mt-0.5 text-[#6b7280]" />
          )}
          <p className={`text-[15px] leading-relaxed ${tone === 'warn' ? '' : 'text-[#454b57]'}`}>{intro}</p>
        </div>
      </div>
    </div>

    <div className="container mx-auto max-w-5xl px-6 py-16">
      <div className="grid md:grid-cols-[220px_1fr] gap-12 items-start">
        <nav className="md:sticky md:top-28 space-y-2" aria-label="On this page">
          <p className="font-bold text-sm tracking-wider uppercase text-gray-900 mb-3">On this page</p>
          {sections.map((s, i) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="block text-sm text-[#454b57] hover:text-black font-medium transition-colors"
            >
              {i + 1}. {s.h}
            </a>
          ))}
        </nav>

        <article className="space-y-12">
          {sections.map((s, i) => (
            <section key={s.id} id={s.id} className="scroll-mt-28 space-y-4">
              <h2 className="text-[22px] font-bold tracking-tight">
                {i + 1}. {s.h}
              </h2>
              {s.body.map((block, j) =>
                Array.isArray(block) ? (
                  <ul key={j} className="space-y-3 list-disc pl-6">
                    {block.map((li, k) => (
                      <li key={k} className="text-[15px] text-[#454b57] leading-relaxed">
                        {li}
                      </li>
                    ))}
                  </ul>
                ) : typeof block === 'object' ? (
                  <div key={j} className="space-y-2">
                    <h3 className="font-bold text-[17px]">{block.h3}</h3>
                    <p className="text-[15px] text-[#454b57] leading-relaxed">{block.p}</p>
                  </div>
                ) : (
                  <p key={j} className="text-[15px] text-[#454b57] leading-relaxed">
                    {block}
                  </p>
                ),
              )}
            </section>
          ))}
        </article>
      </div>
    </div>
  </div>
);

export const Privacy = () => (
  <LegalLayout
    kicker="Legal"
    title="Privacy policy"
    updated="13 August 2026"
    intro={
      <>
        <b className="text-black">The short version.</b> We run no analytics, set no cookies, have no
        accounts and collect no personal information. There are exactly two places where data leaves
        your device, and both are named below.
      </>
    }
    sections={[
      {
        id: 'who',
        h: 'Who we are',
        body: [
          'Firm Quote is an independent prototype built for the BuildX AI Season hackathon on X Layer. It is not a registered financial institution, a broker, an exchange, or a regulated entity of any kind.',
        ],
      },
      {
        id: 'collect',
        h: 'What we collect',
        body: [
          'Nothing that identifies you. There is no sign up, no login, no contact form and no newsletter. We do not ask for your name, email address, phone number or location, and there is nowhere on the site to provide them.',
          'Values you type into the console, such as a wallet address or an exit amount, stay in your browser and are sent only to the protocol backend the page is pointed at. They are not stored on a server we control.',
        ],
      },
      {
        id: 'cookies',
        h: 'Cookies and tracking',
        body: [
          'The site sets no cookies and uses no local storage. There are no analytics, no advertising pixels, no session recording and no fingerprinting. Because there is nothing to consent to, there is no cookie banner.',
        ],
      },
      {
        id: 'fonts',
        h: 'Fonts',
        body: [
          'The site currently loads two typefaces from Google Fonts. That means Google receives your IP address and user agent when the page renders. This is the only third party request the site makes on load, we would rather name it than leave it unmentioned, and self hosting the two font files is a tracked improvement.',
        ],
      },
      {
        id: 'blockchain',
        h: 'Blockchain data',
        body: [
          'This is the section most policies in this industry gloss over. Public blockchains are permanent and public by design.',
          [
            'Any transaction you send is broadcast to a public network and visible to anyone, forever.',
            'That record includes your wallet address, the amounts, the timing and the function you called.',
            'Nobody can delete, edit or anonymise on chain data. This is a property of the technology, not a policy choice.',
            'Wallet addresses are pseudonymous, not anonymous. If an address is ever linked to you elsewhere, its whole history becomes linkable too.',
          ],
        ],
      },
      {
        id: 'third',
        h: 'Third party services',
        body: [
          'When the console is connected to a live network, the following may be contacted. Each has its own policy, which we do not control.',
          [
            'Blockchain RPC providers. Reading state and sending transactions requires contacting a node, and that operator sees your IP address.',
            'OKX DEX aggregator, used for swap routing. Called from our backend rather than your browser.',
            'Anthropic API, used by the risk engine to score a simulated invoice portfolio. No visitor data is included. With no key configured the engine scores locally and contacts nothing.',
          ],
        ],
      },
      {
        id: 'wallets',
        h: 'Wallets and private keys',
        body: [
          'We never ask for a private key, a seed phrase or a recovery phrase, and we never will. Anyone who does is trying to steal from you, including anyone claiming to represent this project.',
          'Connecting a wallet shares your public address with the page and nothing else. We cannot move your funds, and every transaction requires you to approve it in your own wallet.',
          'There is also a demo mode, used when no wallet is connected, where a key held by whoever runs the deployment signs instead. It is labelled in the interface wherever it applies, because a transaction signed by the operator proves less than one signed by you.',
        ],
      },
      {
        id: 'rights',
        h: 'Your rights',
        body: [
          'You may have rights to access, correct, export or delete personal data, including under the GDPR and the CCPA. We can honour those easily, because we hold no personal data. The one real limitation is on chain data, which no party can erase.',
        ],
      },
      {
        id: 'contact',
        h: 'Contact',
        body: [
          'Questions can be raised through the project repository, linked in the footer. As an independent prototype we have no legal entity, no registered office and no data protection officer, and we would rather say so than list an address that does not exist.',
        ],
      },
    ]}
  />
);

export const Terms = () => (
  <LegalLayout
    kicker="Legal"
    title="Terms of service"
    updated="13 August 2026"
    tone="warn"
    intro={
      <>
        <b className="text-gray-300">This is unaudited prototype software built for a hackathon.</b>{' '}
        It is a demonstration, not a financial product. Nothing here is an offer, a solicitation or
        advice. Assume any funds committed to it can be lost in full.
      </>
    }
    sections={[
      {
        id: 'accept',
        h: 'Accepting these terms',
        body: [
          'By using this site or the console you agree to these terms. If you do not agree with any part of them, please do not use the site.',
        ],
      },
      {
        id: 'what',
        h: 'What this is',
        body: [
          'A prototype protocol with two parts. An underwriting layer where a risk model posts collateral behind each score and is slashed when the realised outcome is materially worse. A liquidity layer where a standing pool buys tranche positions from holders who want out early, at a price the same model sets.',
        ],
      },
      {
        id: 'notwhat',
        h: 'What this is not',
        body: [
          [
            'Not a regulated financial service, bank, broker dealer, exchange or custodian.',
            'Not investment, financial, legal or tax advice.',
            'Not an offer to sell or a solicitation to buy any security or financial instrument.',
            'Not audited. No third party security review has been performed on the contracts.',
            'Not insured. There is no deposit protection and no backstop of any kind.',
          ],
        ],
      },
      {
        id: 'risk',
        h: 'Risk disclosure',
        body: [
          'These are the risks we consider material. The list is not exhaustive, and disclosing a risk does not make it acceptable for your circumstances.',
          {
            h3: 'Smart contract risk',
            p: 'The contracts are unaudited. A bug or unforeseen interaction could cause permanent, irreversible loss of every asset held by the protocol. Passing tests show that specified behaviour works, not that unspecified behaviour is impossible.',
          },
          {
            h3: 'Credit risk',
            p: 'The underlying assets are trade receivables and payers default. Losses flow in a fixed order: the operator bond first, then junior capital, then senior. Junior holders should expect to lose principal in an adverse scenario, because absorbing that loss is what the junior tranche is for.',
          },
          {
            h3: 'Liquidity risk',
            p: 'The pool honours a price only while it holds cash and only within its caps. No exit may take more than 20 percent of pool cash, no tranche may exceed 40 percent of pool net asset value, and a quote older than 15 minutes cannot be traded against. A standing bid is not a guarantee of liquidity at any size at any time.',
          },
          {
            h3: 'Model risk',
            p: 'The exit price reflects a model opinion, and models are wrong. Our own reference walkthrough contains a case where the pool buys at 98.03 percent of par and later redeems for less, losing money on the trade. Liquidity providers take the other side of that risk and are compensated by a spread, not protected from loss by it.',
          },
          {
            h3: 'Lock up risk',
            p: 'Tranche positions cannot be redeemed before maturity. This is enforced in the contract, not by policy. The exit pool is the only early route out and is subject to every limitation above.',
          },
          {
            h3: 'Oracle and operator risk',
            p: 'Outcome reporting and price updates are performed by privileged roles held by the deployer in this prototype. A dishonest or compromised operator could report a false outcome or push a mispriced quote.',
          },
          {
            h3: 'Regulatory risk',
            p: 'Treatment of tokenised credit instruments varies by jurisdiction and is changing. A future determination could restrict or prohibit participation where you live.',
          },
        ],
      },
      {
        id: 'sim',
        h: 'Simulated components',
        body: [
          'Stated explicitly rather than left to be discovered. Simulated: the offchain invoice feed, the outcome oracle, and the refreshed data used when repricing for exit.',
          'Real on chain logic with nothing simulated in the path: the reputation gate, bond posting, proportional slashing, the loss waterfall, tranche locking, exit pricing and settlement, and every safety cap.',
        ],
      },
      {
        id: 'eligibility',
        h: 'Eligibility',
        body: [
          'You must be at least 18 and legally able to enter into these terms. Do not use the site if doing so would breach applicable law or sanctions where you are, or if you are subject to sanctions yourself.',
        ],
      },
      {
        id: 'conduct',
        h: 'Acceptable use',
        body: [
          [
            'Do not use the protocol to launder money, finance terrorism or evade sanctions.',
            'Do not attempt to manipulate the reputation gate through sybil wallets or coordinated collusion.',
            'Do not exploit a vulnerability rather than disclosing it responsibly through the repository.',
            'Do not misrepresent the protocol as audited, insured or regulated.',
          ],
        ],
      },
      {
        id: 'ip',
        h: 'Intellectual property',
        body: [
          'The smart contracts are released under the MIT licence and the source is in the project repository. The Firm Quote name and visual design are the work of the maintainers.',
        ],
      },
      {
        id: 'warranty',
        h: 'No warranty',
        body: [
          'The site and the protocol are provided as is and as available, without warranty of any kind. To the fullest extent permitted by law we disclaim all warranties, including merchantability, fitness for a particular purpose, title and non infringement. We do not warrant that any figure displayed is accurate.',
        ],
      },
      {
        id: 'liability',
        h: 'Limitation of liability',
        body: [
          'To the fullest extent permitted by law, the maintainers are not liable for any indirect, incidental, special, consequential or punitive damages, nor for loss of profits, data, goodwill or digital assets. Nothing here excludes liability that cannot lawfully be excluded.',
        ],
      },
      {
        id: 'changes',
        h: 'Changes and availability',
        body: [
          'We may change, suspend or discontinue the site at any time without notice. As a hackathon prototype it may be taken down once judging concludes. Deployed contracts may remain on chain afterwards, and their existence does not imply support or monitoring.',
        ],
      },
      {
        id: 'law',
        h: 'Governing law',
        body: [
          'These terms are governed by the laws of England and Wales, with exclusive jurisdiction in its courts. If you are a consumer, this does not deprive you of mandatory protections where you live. If any provision is unenforceable, the rest continue in effect.',
        ],
      },
    ]}
  />
);
