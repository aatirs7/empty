import { PageTitle } from "@/components/ui";

export const dynamic = "force-static";

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 h-7 w-7 rounded-full bg-accent/15 text-accent grid place-items-center text-sm font-semibold">
        {n}
      </div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-sm text-muted leading-relaxed mt-0.5">{children}</p>
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-panel border border-border rounded-2xl p-4 space-y-4">{children}</div>;
}

export default function StrategyPage() {
  return (
    <div className="space-y-5">
      <PageTitle title="How Vega trades" subtitle="the strategy, in plain English" />

      <p className="text-sm text-muted leading-relaxed text-center">
        Vega follows one simple, mechanical idea. It doesn&apos;t guess or chase headlines. It looks for price levels
        where a stock has reacted strongly before, and bets the stock will react there again.
      </p>

      <Card>
        <p className="text-sm font-semibold">1. It finds &ldquo;zones&rdquo;</p>
        <p className="text-sm text-muted leading-relaxed">
          When a stock makes a big, sudden move in one day, it leaves behind a price area, a <b>zone</b>. Think of a
          zone as a floor or a ceiling: a level where buyers or sellers showed up hard once, and often do again. Vega
          scans the daily chart and finds these automatically. It never reads a chart picture, it calculates the zones
          from the raw numbers.
        </p>
      </Card>

      <Card>
        <p className="text-sm font-semibold">2. It bets on the bounce</p>
        <div className="space-y-3">
          <Step n="↓" title="Price falls into a zone → bet it bounces UP">
            Vega buys a <b>call</b> (a bet the stock rises). The zone is acting like a floor.
          </Step>
          <Step n="↑" title="Price rises into a zone → bet it gets pushed DOWN">
            Vega buys a <b>put</b> (a bet the stock falls). The zone is acting like a ceiling.
          </Step>
        </div>
        <p className="text-xs text-muted leading-relaxed">
          The direction is decided purely by which side the price approaches from. There is no opinion involved.
        </p>
      </Card>

      <Card>
        <p className="text-sm font-semibold">3. Only when the path is clear</p>
        <p className="text-sm text-muted leading-relaxed">
          Vega only takes the trade if there&apos;s <b>open space</b> leading into the zone, with no other zone in the
          way. The zone has to be the first real level the price runs into. No clear path, no trade. This keeps it to
          fewer, cleaner setups instead of trading everything.
        </p>
      </Card>

      <Card>
        <p className="text-sm font-semibold">4. It gets out when the idea fails</p>
        <p className="text-sm text-muted leading-relaxed">
          There&apos;s no fixed profit target, it rides the bounce. Vega exits when the stock <b>closes all the way
          through</b> the zone against the bet, which means the bounce didn&apos;t happen and the idea was wrong. That
          same break often sets up the opposite trade next time.
        </p>
      </Card>

      <Card>
        <p className="text-sm font-semibold">Why options?</p>
        <p className="text-sm text-muted leading-relaxed">
          Instead of buying the stock, Vega buys cheap <b>options</b>, small, defined bets. The most you can lose is
          what you put in, but if the move is right the payoff is large. Vega deliberately buys inexpensive ones so it
          can spread across several ideas.
        </p>
      </Card>

      <div className="bg-panel border border-accent/30 rounded-2xl p-4">
        <p className="text-sm font-semibold">The honest part</p>
        <p className="text-sm text-muted leading-relaxed mt-1">
          This is an <b>unproven idea being tested with fake money</b> on a $500 practice account. It might not work.
          Every setup is also tracked mechanically and scored against a dumb benchmark, just buying the S&amp;P 500 every
          day. If the strategy can&apos;t beat that lazy option, it has no real edge and isn&apos;t worth using. That&apos;s
          the whole point of the test. None of this is financial advice.
        </p>
      </div>
    </div>
  );
}
