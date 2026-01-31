import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, ArrowRight, Loader2, Users } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";

const SPEAKER_ROLES = {
  government: [
    { value: "pm", label: "Prime Minister", short: "PM" },
    { value: "dpm", label: "Deputy Prime Minister", short: "DPM" },
    { value: "gw", label: "Government Whip", short: "GW" },
  ],
  opposition: [
    { value: "lo", label: "Leader of Opposition", short: "LO" },
    { value: "dlo", label: "Deputy Leader of Opposition", short: "DLO" },
    { value: "ow", label: "Opposition Whip", short: "OW" },
  ],
};

export default function JoinRoom() {
  const { user, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  
  const [roomCode, setRoomCode] = useState("");
  const [team, setTeam] = useState<"government" | "opposition" | null>(null);
  const [speakerRole, setSpeakerRole] = useState("");
  const checkRoom = trpc.debate.getByRoomCode.useQuery(
    { roomCode: roomCode.toUpperCase() },
    { enabled: roomCode.length === 8 }
  );

  // Use the query data directly
  const roomInfo = checkRoom.data;

  const joinDebate = trpc.debate.join.useMutation({
    onSuccess: (data) => {
      toast.success("Joined debate room!");
      navigate(`/room/${roomCode.toUpperCase()}`);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const handleJoin = () => {
    if (!team || !speakerRole) {
      toast.error("Please select a team and role");
      return;
    }

    joinDebate.mutate({
      roomCode: roomCode.toUpperCase(),
      team,
      speakerRole: speakerRole as any,
    });
  };

  const getAvailableRoles = (teamType: "government" | "opposition") => {
    if (!roomInfo?.participants) return SPEAKER_ROLES[teamType];
    
    const takenRoles = roomInfo.participants
      .filter((p: any) => p.team === teamType)
      .map((p: any) => p.speakerRole);
    
    return SPEAKER_ROLES[teamType].map(role => ({
      ...role,
      taken: takenRoles.includes(role.value),
    }));
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-black uppercase mb-4">Sign In Required</h1>
          <p className="text-muted-foreground mb-8">Please sign in to join a debate room.</p>
          <Link href="/">
            <Button className="brutalist-border">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b-4 border-foreground">
        <div className="container flex items-center h-20">
          <Link href="/" className="no-underline hover:bg-transparent">
            <span className="text-2xl font-black tracking-tighter uppercase">
              [DEBATE.AI]
            </span>
          </Link>
        </div>
      </header>

      <main className="container py-12">
        <div className="max-w-2xl mx-auto">
          {/* Back link */}
          <Link href="/" className="inline-flex items-center gap-2 mb-8 font-bold uppercase tracking-wider text-sm hover:underline decoration-2 underline-offset-4 no-underline hover:bg-transparent">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>

          <div className="mb-12">
            <h1 className="text-display mb-4">JOIN ROOM</h1>
            <p className="text-xl text-muted-foreground">
              Enter the room code shared by your team to join the debate.
            </p>
          </div>

          <div className="space-y-8">
            {/* Room Code Input */}
            <div className="space-y-3">
              <Label className="text-sm font-black uppercase tracking-wider">Room Code</Label>
              <Input
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase().slice(0, 8))}
                placeholder="XXXXXXXX"
                className="brutalist-border h-20 text-4xl font-black text-center tracking-[0.5em] uppercase"
                maxLength={8}
              />
              {roomCode.length === 8 && checkRoom.isLoading && (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking room...
                </p>
              )}
              {roomCode.length === 8 && !checkRoom.isLoading && checkRoom.isError && (
                <p className="text-sm text-destructive font-bold">Room not found</p>
              )}
            </div>

            {/* Room Info */}
            {roomInfo && (
              <div className="brutalist-border p-6 animate-brutalist-appear">
                <div className="flex items-center gap-3 mb-4">
                  <Users className="h-5 w-5" />
                  <span className="font-black uppercase">
                    {roomInfo.participants?.length || 0}/6 Debaters
                  </span>
                  <span className={`ml-auto px-3 py-1 text-sm font-bold uppercase ${
                    roomInfo.session?.status === "waiting" 
                      ? "bg-muted" 
                      : roomInfo.session?.status === "in_progress"
                      ? "bg-foreground text-background"
                      : "bg-muted-foreground text-background"
                  }`}>
                    {roomInfo.session?.status || "Unknown"}
                  </span>
                </div>
                {roomInfo.motion && (
                  <div>
                    <p className="text-sm font-black uppercase tracking-wider text-muted-foreground mb-1">
                      Motion
                    </p>
                    <p className="font-bold">{roomInfo.motion.title}</p>
                  </div>
                )}
              </div>
            )}

            {/* Team Selection */}
            {roomInfo && roomInfo.session?.status === "waiting" && (
              <div className="space-y-6 animate-brutalist-appear">
                <div className="space-y-3">
                  <Label className="text-sm font-black uppercase tracking-wider">Select Team</Label>
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      onClick={() => { setTeam("government"); setSpeakerRole(""); }}
                      className={`brutalist-border p-6 text-left transition-all ${
                        team === "government" 
                          ? "bg-foreground text-background" 
                          : "hover:bg-muted"
                      }`}
                    >
                      <p className="text-xl font-black uppercase mb-1">Government</p>
                      <p className={`text-sm ${team === "government" ? "text-background/70" : "text-muted-foreground"}`}>
                        Propose the motion
                      </p>
                    </button>
                    <button
                      onClick={() => { setTeam("opposition"); setSpeakerRole(""); }}
                      className={`brutalist-border p-6 text-left transition-all ${
                        team === "opposition" 
                          ? "bg-muted-foreground text-background" 
                          : "hover:bg-muted"
                      }`}
                    >
                      <p className="text-xl font-black uppercase mb-1">Opposition</p>
                      <p className={`text-sm ${team === "opposition" ? "text-background/70" : "text-muted-foreground"}`}>
                        Oppose the motion
                      </p>
                    </button>
                  </div>
                </div>

                {/* Role Selection */}
                {team && (
                  <div className="space-y-3 animate-brutalist-appear">
                    <Label className="text-sm font-black uppercase tracking-wider">Select Role</Label>
                    <div className="grid gap-3">
                      {getAvailableRoles(team).map((role: any) => (
                        <button
                          key={role.value}
                          onClick={() => !role.taken && setSpeakerRole(role.value)}
                          disabled={role.taken}
                          className={`brutalist-border p-4 text-left transition-all ${
                            role.taken 
                              ? "opacity-50 cursor-not-allowed bg-muted" 
                              : speakerRole === role.value
                              ? team === "government"
                                ? "bg-foreground text-background"
                                : "bg-muted-foreground text-background"
                              : "hover:bg-muted"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="font-black uppercase">{role.label}</span>
                              <span className="ml-2 text-sm opacity-70">({role.short})</span>
                            </div>
                            {role.taken && (
                              <span className="text-sm font-bold uppercase">Taken</span>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Join Button */}
                <div className="pt-8 border-t-4 border-foreground">
                  <Button
                    onClick={handleJoin}
                    disabled={!team || !speakerRole || joinDebate.isPending}
                    className="brutalist-border brutalist-shadow-lg brutalist-shadow-hover transition-all uppercase font-black tracking-wider px-12 py-8 h-auto text-xl"
                  >
                    {joinDebate.isPending ? (
                      <>
                        <Loader2 className="mr-3 h-6 w-6 animate-spin" />
                        Joining...
                      </>
                    ) : (
                      <>
                        Join Debate
                        <ArrowRight className="ml-3 h-6 w-6" />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {roomInfo && roomInfo.session?.status !== "waiting" && (
              <div className="brutalist-border p-8 text-center">
                <p className="text-xl font-black uppercase mb-2">
                  {roomInfo.session?.status === "in_progress" 
                    ? "Debate In Progress" 
                    : "Debate Ended"}
                </p>
                <p className="text-muted-foreground">
                  {roomInfo.session?.status === "in_progress" 
                    ? "This debate has already started. You cannot join now." 
                    : "This debate has ended."}
                </p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
