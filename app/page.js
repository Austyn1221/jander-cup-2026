"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

const baseTabs = ["Live", "Score", "Leaderboard", "Chat"];

export default function App() {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState("");
  const [players, setPlayers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [scores, setScores] = useState([]);
  const [scrambleScores, setScrambleScores] = useState([]);
  const [matchups, setMatchups] = useState([]);
  const [msgs, setMsgs] = useState([]);
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState("Live");
  const [rn, setRn] = useState(1);
  const [hole, setHole] = useState(1);
  const [draft, setDraft] = useState({});
  const [scrambleDraft, setScrambleDraft] = useState({});
  const [pairDraft, setPairDraft] = useState({});
  const [chat, setChat] = useState("");

  const load = useCallback(async () => {
    const [p, t, r, s, ss, mu, m] = await Promise.all([
      supabase.from("players").select("*").order("name"),
      supabase.from("teams").select("*").order("name"),
      supabase
        .from("rounds")
        .select("*,courses(id,name,tee_name,course_holes(hole_number,par,stroke_index,yardage))")
        .order("round_number"),
      supabase.from("hole_scores").select("*"),
      supabase.from("scramble_scores").select("*"),
      supabase.from("matchups").select("*").order("matchup_number"),
      supabase.from("messages").select("*").order("created_at", { ascending: false }).limit(100),
    ]);

    const e = p.error || t.error || r.error || s.error || ss.error || mu.error || m.error;
    if (e) throw e;

    setPlayers(p.data || []);
    setTeams(t.data || []);
    setRounds(r.data || []);
    setScores(s.data || []);
    setScrambleScores(ss.data || []);
    setMatchups(mu.data || []);
    setMsgs(m.data || []);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          const x = await supabase.auth.signInAnonymously();
          if (x.error) throw x.error;
        }
        await load();
        const id = localStorage.getItem("jander-player");
        if (id) {
          const x = await supabase.from("players").select("*").eq("id", id).maybeSingle();
          if (x.data) setMe(x.data);
        }
      } catch (e) {
        setErr(e.message);
      } finally {
        setReady(true);
      }
    })();
  }, [load]);

  useEffect(() => {
    if (!ready) return;
    const c = supabase
      .channel("jander-live-v2")
      .on("postgres_changes", { event: "*", schema: "public", table: "hole_scores" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "scramble_scores" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "matchups" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, load)
      .subscribe();
    return () => supabase.removeChannel(c);
  }, [ready, load]);

  const round = rounds.find((x) => x.round_number === rn);
  const roundMatchups = matchups
    .filter((m) => m.round_id === round?.id)
    .sort((a, b) => a.matchup_number - b.matchup_number);

  const courseHole = useMemo(() => {
    const hs = round?.courses?.course_holes || [];
    return hs.find((h) => h.hole_number === Number(hole));
  }, [round, hole]);

  const isScramble = round?.format === "scramble";
  const isIndividual = round?.format === "individual";
  const isOrganizer = !!me?.is_organizer || me?.name?.toLowerCase() === "austyn anderson";
  const tabs = isOrganizer ? [...baseTabs, "Admin"] : baseTabs;

  const team1 = teams[0];
  const team2 = teams[1];

  function player(id) {
    return players.find((p) => p.id === id);
  }

  function hcp(p) {
    return Number(p?.playing_handicap ?? p?.handicap ?? 0);
  }

  function strokesForHole(p, ch = courseHole) {
    if (!p || !ch) return 0;
    const handicap = hcp(p);
    if (handicap <= 0) return 0;
    const full = Math.floor(handicap / 18);
    const extra = handicap % 18;
    return full + (ch.stroke_index <= extra ? 1 : 0);
  }

  function netFor(p, gross) {
    return Number(gross) - strokesForHole(p);
  }

  function scoreLabel(p, gross) {
    if (!courseHole || gross === "" || gross == null) return "";
    const strokes = strokesForHole(p);
    const net = Number(gross) - strokes;
    return `Gross ${gross} • ${strokes ? `${strokes} stroke${strokes > 1 ? "s" : ""} • ` : ""}Net ${net}`;
  }

  async function saveIndividualHole() {
    try {
      setErr("");
      const { data: { user } } = await supabase.auth.getUser();

      let eligible = players;
      if (!isIndividual && roundMatchups.length) {
        const ids = new Set(
          roundMatchups.flatMap((m) => [
            m.team1_player1_id, m.team1_player2_id,
            m.team2_player1_id, m.team2_player2_id,
          ]).filter(Boolean)
        );
        eligible = players.filter((p) => ids.has(p.id));
      }

      const rows = eligible
        .filter((p) => draft[p.id] !== undefined && draft[p.id] !== "")
        .map((p) => {
          const gross = Number(draft[p.id]);
          const strokes = isIndividual ? 0 : strokesForHole(p);
          const net = gross - strokes;
          const par = Number(courseHole?.par || 0);
          const netToPar = par ? net - par : null;
          const grossToPar = par ? gross - par : null;

          let birdieBonus = 0;
          let eagleBonus = 0;
          if (round?.format === "best_ball" && netToPar != null && netToPar <= -1) {
            birdieBonus = Number(round.birdie_bonus || 1);
          }
          if (round?.format === "high_low") {
            if (netToPar === -1) birdieBonus = Number(round.birdie_bonus || 1);
            if (netToPar <= -2) eagleBonus = Number(round.eagle_bonus || 2);
          }

          return {
            round_id: round.id,
            player_id: p.id,
            hole_number: Number(hole),
            gross_score: gross,
            handicap_strokes: strokes,
            net_score: net,
            net_to_par: netToPar,
            gross_to_par: grossToPar,
            birdie_bonus_points: birdieBonus,
            eagle_bonus_points: eagleBonus,
            total_bonus_points: birdieBonus + eagleBonus,
            entered_by: user.id,
          };
        });

      if (!rows.length) throw Error("Enter at least one score.");

      const x = await supabase
        .from("hole_scores")
        .upsert(rows, { onConflict: "round_id,player_id,hole_number" });
      if (x.error) throw x.error;

      setDraft({});
      await load();
      if (hole < 18) setHole((h) => h + 1);
      setTab("Live");
    } catch (e) {
      setErr(e.message);
    }
  }

  function scrambleHandicap(a, b) {
    const hs = [hcp(a), hcp(b)].sort((x, y) => x - y);
    if (hs.length < 2) return 0;
    return Math.round((0.35 * hs[0] + 0.15 * hs[1]) * 10) / 10;
  }

  async function saveScrambleHole() {
    try {
      setErr("");
      const { data: { user } } = await supabase.auth.getUser();
      const rows = [];

      for (const m of roundMatchups) {
        for (const side of ["team1", "team2"]) {
          const teamId = side === "team1" ? team1?.id : team2?.id;
          const key = `${m.id}-${teamId}`;
          const val = scrambleDraft[key];
          if (val === undefined || val === "") continue;

          const p1 = player(m[`${side}_player1_id`]);
          const p2 = player(m[`${side}_player2_id`]);
          const gross = Number(val);
          const par = Number(courseHole?.par || 0);
          const pairHcp = scrambleHandicap(p1, p2);

          rows.push({
            matchup_id: m.id,
            round_id: round.id,
            matchup_number: m.matchup_number,
            team_id: teamId,
            hole_number: Number(hole),
            gross_score: gross,
            handicap_strokes: pairHcp,
            net_score: gross,
            gross_to_par: par ? gross - par : null,
            birdie_bonus_points: par && gross <= par - 1 ? Number(round.birdie_bonus || 1) : 0,
            entered_by: user.id,
          });
        }
      }

      if (!rows.length) throw Error("Enter at least one scramble score.");

      const x = await supabase
        .from("scramble_scores")
        .upsert(rows, { onConflict: "matchup_id,team_id,hole_number" });
      if (x.error) throw x.error;

      setScrambleDraft({});
      await load();
      if (hole < 18) setHole((h) => h + 1);
      setTab("Live");
    } catch (e) {
      setErr(e.message);
    }
  }

  async function savePairings() {
    try {
      setErr("");
      const updates = roundMatchups.map((m) => {
        const d = pairDraft[m.id] || {};
        return supabase
          .from("matchups")
          .update({
            team1_player1_id: d.team1_player1_id ?? m.team1_player1_id,
            team1_player2_id: d.team1_player2_id ?? m.team1_player2_id,
            team2_player1_id: d.team2_player1_id ?? m.team2_player1_id,
            team2_player2_id: d.team2_player2_id ?? m.team2_player2_id,
          })
          .eq("id", m.id);
      });

      const results = await Promise.all(updates);
      const bad = results.find((x) => x.error);
      if (bad?.error) throw bad.error;

      setPairDraft({});
      await load();
    } catch (e) {
      setErr(e.message);
    }
  }

  async function send() {
    if (!chat.trim()) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const x = await supabase.from("messages").insert({
        tournament_id: me.tournament_id,
        player_id: me.id,
        auth_user_id: user.id,
        body: chat.trim(),
      });
      if (x.error) throw x.error;
      setChat("");
    } catch (e) {
      setErr(e.message);
    }
  }

  if (!ready) return <main className="join"><h1>JANDER CUP</h1><p>Connecting…</p></main>;

  if (!me) {
    return (
      <main className="join">
        <p className="gold">CRANBROOK • 2026</p>
        <h1>JANDER CUP</h1>
        <p>Choose your golfer.</p>
        {err && <div className="error">{err}</div>}
        <div className="grid">
          {players.map((p) => (
            <button key={p.id} onClick={() => {
              localStorage.setItem("jander-player", p.id);
              setMe(p);
            }}>
              <b>{p.name}</b>
              <small>HCP {hcp(p)}</small>
            </button>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <header>
        <div>
          <p className="gold">JANDER CUP 2026</p>
          <h2>{tab}</h2>
        </div>
        <button className="pill" onClick={() => {
          localStorage.removeItem("jander-player");
          setMe(null);
        }}>
          {me.name.split(" ")[0]}
        </button>
      </header>

      {err && <div className="error">{err}</div>}

      {tab === "Live" && (
        <>
          <div className="hero">
            <p className="gold">LIVE TOURNAMENT</p>
            <h1>JANDER CUP</h1>
            <p>Cranbrook, British Columbia</p>
          </div>

          <Card title="Course Rotation">
            {rounds.map((r) => (
              <div className="row" key={r.id}>
                <b>R{r.round_number}</b>
                <span>{r.courses?.name}{r.courses?.tee_name ? ` • ${r.courses.tee_name}` : ""}</span>
                <small>{fmt(r.format)}</small>
              </div>
            ))}
          </Card>

          <Card title={`Round ${rn} Matchups`}>
            {rn <= 4 && roundMatchups.map((m) => (
              <div className="row" key={m.id}>
                <b>Match {m.matchup_number}</b>
                <span>
                  {pairNames(m, "team1", player)} vs {pairNames(m, "team2", player)}
                </span>
              </div>
            ))}
            {rn > 4 && <p>Individual Championship</p>}
          </Card>

          <Card title="Recent Scores">
            {[
              ...scores.map((s) => ({ ...s, kind: "player" })),
              ...scrambleScores.map((s) => ({ ...s, kind: "scramble" })),
            ]
              .slice(-12)
              .reverse()
              .map((s) => (
                <div className="row" key={`${s.kind}-${s.id}`}>
                  <b>
                    {s.kind === "player"
                      ? player(s.player_id)?.name
                      : `${teams.find((t) => t.id === s.team_id)?.name} Scramble`}
                  </b>
                  <span>#{s.hole_number}</span>
                  <strong>{s.gross_score}</strong>
                </div>
              ))}
          </Card>
        </>
      )}

      {tab === "Score" && (
        <>
          <div className="controls">
            <select value={rn} onChange={(e) => {
              setRn(Number(e.target.value));
              setDraft({});
              setScrambleDraft({});
            }}>
              {rounds.map((r) => (
                <option key={r.id} value={r.round_number}>
                  Round {r.round_number} — {fmt(r.format)}
                </option>
              ))}
            </select>

            <select value={hole} onChange={(e) => setHole(Number(e.target.value))}>
              {[...Array(18)].map((_, i) => <option key={i}>{i + 1}</option>)}
            </select>
          </div>

          <Card title={`Round ${rn} • Hole ${hole}`}>
            <p>
              {round?.courses?.name}
              {round?.courses?.tee_name ? ` • ${round.courses.tee_name}` : ""}
            </p>
            {courseHole && (
              <p className="gold">
                Par {courseHole.par} • {courseHole.yardage} yds • HCP {courseHole.stroke_index}
              </p>
            )}

            {isScramble ? (
              <>
                {roundMatchups.map((m) => (
                  <div key={m.id}>
                    <h3 className="gold">Match {m.matchup_number}</h3>
                    {[["team1", team1], ["team2", team2]].map(([side, team]) => {
                      const p1 = player(m[`${side}_player1_id`]);
                      const p2 = player(m[`${side}_player2_id`]);
                      const key = `${m.id}-${team?.id}`;
                      const old = scrambleScores.find(
                        (s) => s.matchup_id === m.id &&
                          s.team_id === team?.id &&
                          s.hole_number === Number(hole)
                      );
                      return (
                        <label className="score" key={key}>
                          <span>
                            <b>{p1?.name || "Choose player"} / {p2?.name || "Choose player"}</b>
                            <small>
                              ONE team score • Scramble HCP {scrambleHandicap(p1, p2)}
                            </small>
                          </span>
                          <input
                            type="number"
                            min="1"
                            max="20"
                            placeholder={old?.gross_score || "—"}
                            value={scrambleDraft[key] || ""}
                            onChange={(e) => setScrambleDraft({
                              ...scrambleDraft,
                              [key]: e.target.value,
                            })}
                          />
                        </label>
                      );
                    })}
                  </div>
                ))}
                {!roundMatchups.length && <p>Set the pairings in Admin first.</p>}
                <button className="primary" onClick={saveScrambleHole}>
                  Save Scramble Hole
                </button>
              </>
            ) : (
              <>
                {(isIndividual ? teams : [team1, team2]).filter(Boolean).map((t) => (
                  <div key={t.id}>
                    <h3 className="gold">{t.name}</h3>
                    {players
                      .filter((p) => p.team_id === t.id)
                      .filter((p) => {
                        if (isIndividual || !roundMatchups.length) return true;
                        return roundMatchups.some((m) =>
                          [
                            m.team1_player1_id, m.team1_player2_id,
                            m.team2_player1_id, m.team2_player2_id,
                          ].includes(p.id)
                        );
                      })
                      .map((p) => {
                        const old = scores.find(
                          (s) => s.round_id === round?.id &&
                            s.player_id === p.id &&
                            s.hole_number === Number(hole)
                        );
                        const current = draft[p.id];
                        return (
                          <label className="score" key={p.id}>
                            <span>
                              <b>{p.name}</b>
                              <small>
                                HCP {hcp(p)}
                                {!isIndividual && courseHole
                                  ? ` • ${strokesForHole(p)} stroke${strokesForHole(p) === 1 ? "" : "s"}`
                                  : ""}
                              </small>
                              {current && <small>{scoreLabel(p, current)}</small>}
                            </span>
                            <input
                              type="number"
                              min="1"
                              max="20"
                              placeholder={old?.gross_score || "—"}
                              value={draft[p.id] || ""}
                              onChange={(e) => setDraft({ ...draft, [p.id]: e.target.value })}
                            />
                          </label>
                        );
                      })}
                  </div>
                ))}
                <button className="primary" onClick={saveIndividualHole}>
                  Save Hole
                </button>
              </>
            )}
          </Card>
        </>
      )}

      {tab === "Leaderboard" && (
        <>
          <Card title="Individual Gross Totals">
            {players.map((p) => {
              const ps = scores.filter((s) => s.player_id === p.id);
              return (
                <div className="row" key={p.id}>
                  <b>{p.name}</b>
                  <span>{ps.length} scores</span>
                  <strong>{ps.reduce((a, b) => a + (b.gross_score || 0), 0) || "—"}</strong>
                </div>
              );
            })}
          </Card>
          <Card title="Jander Cup Scoring">
            <p>
              Pairings and format-aware score entry are now live. Automatic match points,
              front/back bonuses and the overall team total are the next scoring layer.
            </p>
          </Card>
        </>
      )}

      {tab === "Chat" && (
        <Card title="Tournament Chat">
          <div className="messages">
            {msgs.map((m) => (
              <div className="msg" key={m.id}>
                <b>{player(m.player_id)?.name || "Jander Cup"}</b>
                <p>{m.body}</p>
              </div>
            ))}
          </div>
          <div className="chat">
            <input
              value={chat}
              onChange={(e) => setChat(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Talk some trash…"
            />
            <button onClick={send}>Send</button>
          </div>
        </Card>
      )}

      {tab === "Admin" && isOrganizer && (
        <>
          <div className="controls">
            <select value={rn} onChange={(e) => setRn(Number(e.target.value))}>
              {rounds.filter((r) => r.round_number <= 4).map((r) => (
                <option key={r.id} value={r.round_number}>
                  Round {r.round_number} — {fmt(r.format)}
                </option>
              ))}
            </select>
          </div>

          <Card title={`Round ${rn} Pairings`}>
            <p>Select the two 2v2 matches. Each golfer should appear once in the round.</p>

            {roundMatchups.map((m) => (
              <div key={m.id}>
                <h3 className="gold">Match {m.matchup_number}</h3>

                <PairSelect
                  label={team1?.name || "Team 1"}
                  team={team1}
                  players={players}
                  value1={(pairDraft[m.id] || {}).team1_player1_id ?? m.team1_player1_id ?? ""}
                  value2={(pairDraft[m.id] || {}).team1_player2_id ?? m.team1_player2_id ?? ""}
                  on1={(v) => setPairDraft({
                    ...pairDraft,
                    [m.id]: { ...(pairDraft[m.id] || {}), team1_player1_id: v },
                  })}
                  on2={(v) => setPairDraft({
                    ...pairDraft,
                    [m.id]: { ...(pairDraft[m.id] || {}), team1_player2_id: v },
                  })}
                />

                <PairSelect
                  label={team2?.name || "Team 2"}
                  team={team2}
                  players={players}
                  value1={(pairDraft[m.id] || {}).team2_player1_id ?? m.team2_player1_id ?? ""}
                  value2={(pairDraft[m.id] || {}).team2_player2_id ?? m.team2_player2_id ?? ""}
                  on1={(v) => setPairDraft({
                    ...pairDraft,
                    [m.id]: { ...(pairDraft[m.id] || {}), team2_player1_id: v },
                  })}
                  on2={(v) => setPairDraft({
                    ...pairDraft,
                    [m.id]: { ...(pairDraft[m.id] || {}), team2_player2_id: v },
                  })}
                />
              </div>
            ))}

            <button className="primary" onClick={savePairings}>Save Pairings</button>
          </Card>
        </>
      )}

      <nav>
        {tabs.map((x) => (
          <button
            key={x}
            className={tab === x ? "active" : ""}
            onClick={() => setTab(x)}
          >
            {x}
          </button>
        ))}
      </nav>
    </main>
  );
}

function PairSelect({ label, team, players, value1, value2, on1, on2 }) {
  const ps = players.filter((p) => p.team_id === team?.id);
  return (
    <div>
      <p><b>{label}</b></p>
      <div className="controls">
        <select value={value1} onChange={(e) => on1(e.target.value)}>
          <option value="">Player 1</option>
          {ps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={value2} onChange={(e) => on2(e.target.value)}>
          <option value="">Player 2</option>
          {ps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
    </div>
  );
}

function pairNames(m, side, getPlayer) {
  const a = getPlayer(m[`${side}_player1_id`])?.name;
  const b = getPlayer(m[`${side}_player2_id`])?.name;
  return a && b ? `${a} / ${b}` : "Pairing TBD";
}

function Card({ title, children }) {
  return <section className="card"><h3>{title}</h3>{children}</section>;
}

function fmt(x) {
  return ({
    best_ball: "Best Ball",
    scramble: "Scramble",
    high_low: "High / Low",
    individual: "Individual",
  })[x] || x;
}
