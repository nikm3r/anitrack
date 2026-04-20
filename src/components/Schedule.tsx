import React, { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { Anime } from "../types/anime";
import ContextMenu from "./ContextMenu";

interface ScheduleItem {
  slug: string;
  episodeNumber: number | null;
  subTime: string | null;
  rawTime: string | null;
  libraryAnime: Anime;
}

interface ScheduleData {
  week: string;
  days: Record<string, ScheduleItem[]>;
}

interface Props {
  animeList: Anime[];
  settings: any;
  onSearchRequest: (query: string) => void;
  onUpdate: (updated: Partial<Anime> & { id: number }) => void;
  onRemove?: (id: number) => void;
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

function toLocalDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getMondayOfWeek(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return toLocalDateStr(d);
}

function addDays(mondayStr: string, days: number): string {
  const d = new Date(mondayStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

function formatWeekLabel(mondayStr: string): string {
  const monday = new Date(mondayStr + "T00:00:00");
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

function getDayDate(mondayStr: string, dayIndex: number): Date {
  const d = new Date(mondayStr + "T00:00:00");
  d.setDate(d.getDate() + dayIndex);
  return d;
}

function isToday(mondayStr: string, dayIndex: number): boolean {
  return getDayDate(mondayStr, dayIndex).toDateString() === new Date().toDateString();
}

function proxyUrl(url: string | null): string | null {
  if (!url) return null;
  return `http://localhost:3000/api/tracker/proxy-image?url=${encodeURIComponent(url)}`;
}

interface ContextMenuState { visible: boolean; x: number; y: number; anime: Anime | null; }

// ─── Row item ─────────────────────────────────────────────────────────────────

function ScheduleRow({ item, onContextMenu }: {
  item: ScheduleItem;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [imgError, setImgError] = useState(false);
  const anime = item.libraryAnime;
  const cover = imgError ? null : proxyUrl(anime.cover_image);
  const title = anime.title_english || anime.title_romaji;

  return (
    <div
      onContextMenu={onContextMenu}
      className="flex gap-2 p-1.5 rounded-lg hover:bg-white/5 cursor-pointer transition-colors group"
    >
      {/* Thumbnail */}
      <div className="w-10 h-14 rounded-md overflow-hidden flex-shrink-0 bg-zinc-800">
        {cover ? (
          <img
            src={cover}
            alt={title}
            onError={() => setImgError(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-zinc-800" />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
        <p className="text-sm font-semibold text-zinc-200 leading-tight line-clamp-2 group-hover:text-white transition-colors">
          {title}
        </p>
        <div className="flex flex-col gap-0.5">
          {item.episodeNumber != null && (
            <span className="text-xs text-zinc-500">EP {String(item.episodeNumber).padStart(2, "0")}</span>
          )}
          {item.subTime && (
            <span className="text-xs text-emerald-500/80">{item.subTime}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Schedule({ settings, onSearchRequest, onUpdate, onRemove }: Props) {
  const [currentMonday, setCurrentMonday] = useState<string>(() =>
    getMondayOfWeek(new Date())
  );
  const [scheduleData, setScheduleData] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, anime: null });

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const fetchSchedule = useCallback(async (week: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`http://localhost:3000/api/schedule?week=${week}&timezone=${encodeURIComponent(timezone)}`);
      if (!res.ok) throw new Error("Failed");
      setScheduleData(await res.json());
    } catch {
      setError("Failed to load schedule.");
    } finally {
      setLoading(false);
    }
  }, [timezone]);

  useEffect(() => { fetchSchedule(currentMonday); }, [currentMonday, fetchSchedule]);

  const closeMenu = () => setContextMenu({ visible: false, x: 0, y: 0, anime: null });

  const totalShows = scheduleData
    ? DAYS.reduce((acc, d) => acc + (scheduleData.days[d]?.length ?? 0), 0)
    : 0;

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* Top bar */}
      <div className="flex items-center gap-4 mb-5 flex-shrink-0">
        <h1 className="text-2xl font-bold text-zinc-100 tracking-tight">Schedule</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => setCurrentMonday(addDays(currentMonday, -7))}
            className="w-7 h-7 rounded-lg bg-white/5 border border-white/8 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all">
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setCurrentMonday(getMondayOfWeek(new Date()))}
            className="px-3 h-7 rounded-lg bg-white/5 border border-white/8 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all">
            {formatWeekLabel(currentMonday)}
          </button>
          <button onClick={() => setCurrentMonday(addDays(currentMonday, 7))}
            className="w-7 h-7 rounded-lg bg-white/5 border border-white/8 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all">
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <button onClick={() => fetchSchedule(currentMonday)}
          className="w-7 h-7 rounded-lg bg-white/5 border border-white/8 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
        {!loading && scheduleData && <span className="text-xs text-zinc-600">{totalShows} shows</span>}
      </div>

      {error && <div className="text-zinc-500 text-sm">{error}</div>}

      {!error && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="grid grid-cols-7 gap-2 h-full">
            {DAYS.map((day, dayIdx) => {
              const today = scheduleData ? isToday(scheduleData.week, dayIdx) : false;
              const items = scheduleData?.days[day] ?? [];
              const dayDate = scheduleData ? getDayDate(scheduleData.week, dayIdx) : null;
              const dateLabel = dayDate
                ? dayDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
                : DAYS[dayIdx];

              return (
                <div key={day} className={`flex flex-col rounded-xl border ${today ? "border-emerald-500/30 bg-emerald-500/5" : "border-white/5 bg-white/[0.02]"}`}>
                  {/* Day header */}
                  <div className={`px-3 py-2.5 border-b ${today ? "border-emerald-500/20" : "border-white/5"}`}>
                    <p className={`text-xs font-bold uppercase tracking-wider ${today ? "text-emerald-400" : "text-zinc-500"}`}>
                      {dateLabel}
                    </p>
                    {today && <p className="text-[10px] text-emerald-600 mt-0.5">Today</p>}
                  </div>

                  {/* Items */}
                  <div className="flex-1 overflow-y-auto p-1">
                    {loading && !scheduleData ? (
                      <div className="flex items-center justify-center h-20">
                        <Loader2 className="w-4 h-4 text-zinc-700 animate-spin" />
                      </div>
                    ) : items.length === 0 ? (
                      <div className="flex items-center justify-center h-16">
                        <span className="text-[11px] text-zinc-700">—</span>
                      </div>
                    ) : (
                      items.map((item) => (
                        <ScheduleRow
                          key={item.slug}
                          item={item}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setContextMenu({ visible: true, x: e.clientX, y: e.clientY, anime: item.libraryAnime });
                          }}
                        />
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {contextMenu.visible && contextMenu.anime && (
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y}
          anime={contextMenu.anime}
          onClose={closeMenu}
          onUpdate={(updated) => { onUpdate(updated); closeMenu(); }}
          onRemove={(id) => {
            onRemove?.(id);
            // Remove from local state immediately
            setScheduleData(prev => {
              if (!prev) return prev;
              const days = { ...prev.days };
              for (const day of Object.keys(days)) {
                days[day] = days[day].filter((item: ScheduleItem) => item.libraryAnime.id !== id);
              }
              return { ...prev, days };
            });

          }}
          onSearchRequest={(q) => { onSearchRequest(q); closeMenu(); }}
          settings={settings}
        />
      )}
    </div>
  );
}
