import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
// ScrollArea removed due to React 19 compatibility issue
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/lib/trpc";
import { useSocket } from "@/hooks/useSocket";
import { useAIReferee } from "@/hooks/useAIReferee";
import { 
  ArrowLeft, Mic, MicOff, Play, Pause, Square, 
  Users, AlertTriangle, Hand, ChevronRight,
  Loader2, Copy, Check, Volume2, VolumeX, Bot
} from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";

const AP_SPEAKER_ORDER = ['pm', 'lo', 'dpm', 'dlo', 'gw', 'ow', 'pmr', 'lor'] as const;
const AP_SPEECH_TIMES: Record<string, number> = {
  pm: 7 * 60,
  lo: 7 * 60,
  dpm: 7 * 60,
  dlo: 7 * 60,
  gw: 7 * 60,
  ow: 7 * 60,
  pmr: 4 * 60,
  lor: 4 * 60,
};

const SPEAKER_NAMES: Record<string, string> = {
  pm: "Prime Minister",
  lo: "Leader of Opposition",
  dpm: "Deputy Prime Minister",
  dlo: "Deputy Leader of Opposition",
  gw: "Government Whip",
  ow: "Opposition Whip",
  pmr: "PM Reply",
  lor: "LO Reply",
};

const PROTECTED_TIME = 60; // First and last minute

export default function DebateRoom() {
  const { roomCode } = useParams<{ roomCode: string }>();
  const { user, isAuthenticated } = useAuth();
  
  const [isRecording, setIsRecording] = useState(false);
  const [allTranscripts, setAllTranscripts] = useState<Array<{ speaker: string; text: string; timestamp: number }>>([]);
  const [timer, setTimer] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [currentSpeakerIndex, setCurrentSpeakerIndex] = useState(0);
  const [poiOffered, setPoiOffered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [testingMode, setTestingMode] = useState(true); // Default to testing mode
  const [refereeEnabled, setRefereeEnabled] = useState(true);
  const [lastAnnouncedTime, setLastAnnouncedTime] = useState<number | null>(null);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const recognitionRef = useRef<any>(null);

  // AI Referee
  const referee = useAIReferee({ enabled: refereeEnabled });

  // Fetch room data
  const { data: roomData, isLoading, refetch } = trpc.debate.getByRoomCode.useQuery(
    { roomCode: roomCode || "" },
    { enabled: !!roomCode }
  );

  const startDebate = trpc.debate.start.useMutation({
    onSuccess: (data) => {
      toast.success("Debate started!");
      if (refereeEnabled && roomData?.motion?.title) {
        referee.announceDebateStart(roomData.motion.title);
      }
      refetch();
    },
    onError: (error) => toast.error(error.message),
  });

  const advanceSpeaker = trpc.debate.advanceSpeaker.useMutation({
    onSuccess: (data) => {
      if (data.finished) {
        toast.success("Debate completed!");
        if (refereeEnabled) {
          referee.announceDebateEnd();
        }
      } else {
        const nextRole = data.nextSpeaker || '';
        toast.success(`Next speaker: ${SPEAKER_NAMES[nextRole]}`);
        if (refereeEnabled) {
          referee.announceSpeaker(nextRole);
        }
      }
      setTimer(0);
      setLastAnnouncedTime(null);
      refetch();
    },
    onError: (error) => toast.error(error.message),
  });

  const endDebate = trpc.debate.end.useMutation({
    onSuccess: () => {
      toast.success("Debate ended. Generating feedback...");
      if (refereeEnabled) {
        referee.announceDebateEnd();
      }
      refetch();
    },
    onError: (error) => toast.error(error.message),
  });

  // Get current participant
  const currentParticipant = roomData?.participants?.find(
    (p) => p.userId === user?.id
  );

  // Socket connection
  const socket = useSocket({
    roomCode: roomCode,
    participantId: currentParticipant?.id,
    userId: user?.id,
    onParticipantJoined: (data) => {
      toast.info(`${SPEAKER_NAMES[data.speakerRole]} joined`);
      refetch();
    },
    onParticipantLeft: (data) => {
      toast.info(`${SPEAKER_NAMES[data.speakerRole]} left`);
      refetch();
    },
    onSpeakerStarted: (data) => {
      setCurrentSpeakerIndex(AP_SPEAKER_ORDER.indexOf(data.speakerRole));
      setTimer(0);
      startTimer();
    },
    onSpeakerStopped: () => {
      stopTimer();
    },
    onTranscriptSegment: (data) => {
      setAllTranscripts(prev => [...prev, {
        speaker: data.senderId,
        text: data.text,
        timestamp: data.timestamp,
      }]);
    },
    onPoiOffer: (data) => {
      toast.info(`POI offered by ${SPEAKER_NAMES[data.speakerRole]}`);
    },
    onDebateStarted: () => {
      toast.success("Debate has started!");
      setCurrentSpeakerIndex(0);
      refetch();
    },
    onDebateEnded: () => {
      toast.success("Debate has ended!");
      refetch();
    },
    onSpeakerAdvanced: (data) => {
      const idx = AP_SPEAKER_ORDER.indexOf(data.nextSpeaker);
      setCurrentSpeakerIndex(idx);
      setTimer(0);
    },
    onViolationFlagged: (data) => {
      toast.warning(`Rule violation: ${data.description}`);
      if (refereeEnabled) {
        referee.announceRuleViolation(data.description);
      }
    },
    onRoomState: (data) => {
      setCurrentSpeakerIndex(data.currentSpeakerIndex || 0);
    },
    onParticipantsUpdated: () => {
      // Refetch room data to get updated participant list
      refetch();
    },
  });

  // Timer functions
  const startTimer = useCallback(() => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = setInterval(() => {
      setTimer(prev => prev + 1);
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  const togglePause = () => {
    if (isPaused) {
      startTimer();
      socket.resumeTimer();
    } else {
      stopTimer();
      socket.pauseTimer();
    }
    setIsPaused(!isPaused);
  };

  // Time announcements
  const currentSpeaker = AP_SPEAKER_ORDER[currentSpeakerIndex];
  const maxTime = AP_SPEECH_TIMES[currentSpeaker] || 420;
  const timeRemaining = maxTime - timer;
  const isProtected = timer < PROTECTED_TIME || timeRemaining < PROTECTED_TIME;
  const isOvertime = timer > maxTime;

  // Announce time warnings
  useEffect(() => {
    if (!refereeEnabled || roomData?.session?.status !== "in_progress") return;
    
    // Announce protected time transitions
    if (timer === PROTECTED_TIME && lastAnnouncedTime !== PROTECTED_TIME) {
      referee.announceProtectedTime(true);
      setLastAnnouncedTime(PROTECTED_TIME);
    }
    
    // Time warnings
    if (timeRemaining === 60 && lastAnnouncedTime !== 60) {
      referee.announceTimeWarning(60);
      setLastAnnouncedTime(60);
    } else if (timeRemaining === 30 && lastAnnouncedTime !== 30) {
      referee.announceTimeWarning(30);
      setLastAnnouncedTime(30);
    } else if (timeRemaining === 10 && lastAnnouncedTime !== 10) {
      referee.announceTimeWarning(10);
      setLastAnnouncedTime(10);
    }
    
    // Protected time at end
    if (timeRemaining === PROTECTED_TIME && lastAnnouncedTime !== -PROTECTED_TIME) {
      referee.announceProtectedTime(false);
      setLastAnnouncedTime(-PROTECTED_TIME);
    }
  }, [timer, timeRemaining, refereeEnabled, roomData?.session?.status, lastAnnouncedTime, referee]);

  // Recording functions with real-time transcription
  const startRecording = async () => {
    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          // Send audio data to other participants
          event.data.arrayBuffer().then(buffer => {
            socket.sendAudioData(buffer);
          });
        }
      };

      // Start Web Speech API for real-time transcription
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        
        recognition.onresult = (event: any) => {
          let finalTranscript = '';
          let interimTranscript = '';
          
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finalTranscript += transcript;
            } else {
              interimTranscript += transcript;
            }
          }
          
          if (finalTranscript) {
            // Add to local transcripts
            const newTranscript = {
              speaker: SPEAKER_NAMES[currentSpeaker] || 'Unknown',
              text: finalTranscript,
              timestamp: timer * 1000,
            };
            setAllTranscripts(prev => [...prev, newTranscript]);
            
            // Send to other participants
            socket.sendTranscriptUpdate(0, finalTranscript, timer * 1000);
          }
        };
        
        recognition.onerror = (event: any) => {
          console.error('Speech recognition error:', event.error);
          if (event.error === 'not-allowed') {
            toast.error('Microphone access denied for speech recognition');
          }
        };
        
        recognition.onend = () => {
          // Restart if still recording
          if (isRecording && recognitionRef.current) {
            try {
              recognitionRef.current.start();
            } catch (e) {
              // Ignore if already started
            }
          }
        };
        
        recognitionRef.current = recognition;
        recognition.start();
        toast.success('Speech recognition started');
      } else {
        toast.warning('Speech recognition not supported in this browser');
      }

      mediaRecorder.start(1000);
      setIsRecording(true);
      socket.startSpeaking(0);
      startTimer();
      
      if (refereeEnabled) {
        referee.announceSpeaker(currentSpeaker);
      }
    } catch (error) {
      console.error('Recording error:', error);
      toast.error("Failed to access microphone. Please check permissions.");
    }
  };

  const stopRecording = () => {
    // Stop speech recognition
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        // Ignore
      }
      recognitionRef.current = null;
    }
    
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
      socket.stopSpeaking(0);
      stopTimer();
      if (refereeEnabled) {
        referee.announceSpeechEnd(currentSpeaker);
      }
    }
  };

  // Format time
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const copyRoomCode = () => {
    if (roomCode) {
      navigator.clipboard.writeText(roomCode);
      setCopied(true);
      toast.success("Room code copied!");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Cleanup on unmount - use refs to avoid dependency issues
  const refereeStopRef = useRef(referee.stop);
  refereeStopRef.current = referee.stop;
  
  useEffect(() => {
    return () => {
      stopTimer();
      // Use ref to avoid stale closure
      if (typeof refereeStopRef.current === 'function') {
        refereeStopRef.current();
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (e) {}
      }
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [stopTimer]);

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-black uppercase mb-4">Sign In Required</h1>
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

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin" />
      </div>
    );
  }

  if (!roomData) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-black uppercase mb-4">Room Not Found</h1>
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

  const session = roomData.session;
  const motion = roomData.motion;
  const participants = roomData.participants || [];
  const govTeam = participants.filter(p => p.team === "government");
  const oppTeam = participants.filter(p => p.team === "opposition");
  const isCreator = session?.createdBy === user?.id;
  // In testing mode, allow starting with any participants; otherwise need 6
  const canStart = isCreator && session?.status === "waiting" && (testingMode || participants.length >= 6);
  const isMyTurn = currentParticipant?.speakerRole === currentSpeaker && session?.status === "in_progress";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b-4 border-foreground shrink-0">
        <div className="container flex items-center justify-between h-16">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="no-underline hover:bg-transparent">
              <ArrowLeft className="h-6 w-6" />
            </Link>
            <span className="text-xl font-black tracking-tighter uppercase">
              [DEBATE.AI]
            </span>
          </div>
          <div className="flex items-center gap-4">
            {/* AI Referee Toggle */}
            <div className="flex items-center gap-2 brutalist-border px-3 py-2">
              <Bot className="h-4 w-4" />
              <span className="text-xs font-black uppercase">AI Referee</span>
              <button
                onClick={() => setRefereeEnabled(!refereeEnabled)}
                className={`p-1 ${refereeEnabled ? "text-foreground" : "text-muted-foreground"}`}
              >
                {refereeEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
            </div>
            
            <button
              onClick={copyRoomCode}
              className="flex items-center gap-2 brutalist-border px-4 py-2 font-black uppercase tracking-wider text-sm hover:bg-foreground hover:text-background transition-colors"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {roomCode}
            </button>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              <span className="font-bold">{participants.length}/6</span>
            </div>
            <span className={`px-3 py-1 text-sm font-black uppercase ${
              session?.status === "waiting" 
                ? "bg-muted" 
                : session?.status === "in_progress"
                ? "bg-foreground text-background animate-pulse"
                : "bg-muted-foreground text-background"
            }`}>
              {session?.status}
            </span>
          </div>
        </div>
      </header>

      {/* AI Referee Speaking Indicator */}
      {referee.isSpeaking && (
        <div className="bg-foreground text-background px-4 py-2 text-center animate-pulse">
          <div className="flex items-center justify-center gap-2">
            <Bot className="h-5 w-5" />
            <span className="font-black uppercase text-sm">AI Referee Speaking</span>
            <span className="text-sm opacity-80">"{referee.currentAnnouncement}"</span>
          </div>
        </div>
      )}

      <main className="flex-1 flex overflow-hidden">
        {/* Left Panel - Teams */}
        <div className="w-80 border-r-4 border-foreground flex flex-col shrink-0">
          {/* Government Team */}
          <div className="flex-1 border-b-4 border-foreground p-4 overflow-auto">
            <h3 className="font-black uppercase tracking-wider text-sm mb-4 flex items-center gap-2">
              <div className="w-3 h-3 bg-foreground"></div>
              Government
            </h3>
            <div className="space-y-2">
              {['pm', 'dpm', 'gw'].map((role) => {
                const participant = govTeam.find(p => p.speakerRole === role);
                const isActive = currentSpeaker === role && session?.status === "in_progress";
                return (
                  <div 
                    key={role}
                    className={`brutalist-border p-3 transition-all ${
                      isActive ? "bg-foreground text-background animate-pulse-border" : ""
                    } ${participant ? "" : "opacity-50"}`}
                  >
                    <p className="font-black uppercase text-sm">{SPEAKER_NAMES[role]}</p>
                    <p className="text-xs opacity-70">
                      {participant ? `User ${participant.userId}` : "Empty"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Opposition Team */}
          <div className="flex-1 p-4 overflow-auto">
            <h3 className="font-black uppercase tracking-wider text-sm mb-4 flex items-center gap-2">
              <div className="w-3 h-3 bg-muted-foreground"></div>
              Opposition
            </h3>
            <div className="space-y-2">
              {['lo', 'dlo', 'ow'].map((role) => {
                const participant = oppTeam.find(p => p.speakerRole === role);
                const isActive = currentSpeaker === role && session?.status === "in_progress";
                return (
                  <div 
                    key={role}
                    className={`brutalist-border p-3 transition-all ${
                      isActive ? "bg-muted-foreground text-background animate-pulse-border" : ""
                    } ${participant ? "" : "opacity-50"}`}
                  >
                    <p className="font-black uppercase text-sm">{SPEAKER_NAMES[role]}</p>
                    <p className="text-xs opacity-70">
                      {participant ? `User ${participant.userId}` : "Empty"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Center Panel - Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Motion */}
          <div className="border-b-4 border-foreground p-6 shrink-0">
            <p className="text-sm font-black uppercase tracking-widest text-muted-foreground mb-2">
              Motion
            </p>
            <p className="text-xl font-bold">
              {motion?.title || "No motion set"}
            </p>
          </div>

          {/* Timer & Controls */}
          <div className="border-b-4 border-foreground p-6 shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-black uppercase tracking-widest text-muted-foreground mb-1">
                  {session?.status === "in_progress" ? "Current Speaker" : "Next Speaker"}
                </p>
                <p className="text-2xl font-black uppercase">
                  {SPEAKER_NAMES[currentSpeaker]}
                </p>
              </div>
              
              <div className="text-center">
                <div className={`text-6xl font-black tabular-nums ${
                  isOvertime ? "text-destructive animate-pulse" : 
                  timeRemaining < 60 ? "timer-warning" : ""
                }`}>
                  {isOvertime ? `-${formatTime(timer - maxTime)}` : formatTime(timeRemaining)}
                </div>
                {isProtected && session?.status === "in_progress" && (
                  <p className="text-sm font-bold uppercase text-muted-foreground mt-1">
                    Protected Time
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                {session?.status === "waiting" && isCreator && (
                  <div className="flex flex-col gap-2">
                    {/* Testing Mode Toggle */}
                    <div className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={testingMode}
                        onCheckedChange={(checked) => setTestingMode(checked === true)}
                        id="testing-mode"
                      />
                      <label htmlFor="testing-mode" className="font-bold uppercase text-xs cursor-pointer">
                        Testing Mode
                      </label>
                    </div>
                    
                    <Button
                      onClick={() => startDebate.mutate({ sessionId: session.id, testingMode })}
                      disabled={startDebate.isPending || !canStart}
                      className="brutalist-border brutalist-shadow-hover uppercase font-black"
                    >
                      {startDebate.isPending ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      ) : (
                        <>
                          <Play className="h-5 w-5 mr-2" />
                          Start {testingMode ? "(Test)" : ""}
                        </>
                      )}
                    </Button>
                    {!testingMode && participants.length < 6 && (
                      <p className="text-xs text-muted-foreground">
                        Need {6 - participants.length} more participants
                      </p>
                    )}
                  </div>
                )}
                
                {session?.status === "in_progress" && (
                  <>
                    <Button
                      onClick={togglePause}
                      variant="outline"
                      className="brutalist-border bg-transparent uppercase font-black"
                    >
                      {isPaused ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
                    </Button>
                    
                    {isCreator && (
                      <>
                        <Button
                          onClick={() => advanceSpeaker.mutate({ sessionId: session.id })}
                          disabled={advanceSpeaker.isPending}
                          className="brutalist-border brutalist-shadow-hover uppercase font-black"
                        >
                          <ChevronRight className="h-5 w-5 mr-1" />
                          Next
                        </Button>
                        <Button
                          onClick={() => endDebate.mutate({ sessionId: session.id })}
                          disabled={endDebate.isPending}
                          variant="outline"
                          className="brutalist-border bg-transparent uppercase font-black text-destructive"
                        >
                          <Square className="h-5 w-5 mr-1" />
                          End
                        </Button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Speaker Order Progress */}
            <div className="mt-6 flex gap-1">
              {AP_SPEAKER_ORDER.map((role, idx) => (
                <div
                  key={role}
                  className={`flex-1 h-2 transition-all ${
                    idx < currentSpeakerIndex 
                      ? "bg-foreground" 
                      : idx === currentSpeakerIndex && session?.status === "in_progress"
                      ? "bg-foreground animate-pulse"
                      : "bg-muted"
                  }`}
                  title={SPEAKER_NAMES[role]}
                />
              ))}
            </div>
          </div>

          {/* Transcript Area */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="p-4 border-b-4 border-foreground shrink-0">
              <h3 className="font-black uppercase tracking-wider text-sm">Live Transcript</h3>
            </div>
            <div className="flex-1 p-4 overflow-y-auto">
              {allTranscripts.length === 0 ? (
                <p className="text-muted-foreground text-center py-12">
                  Transcripts will appear here during the debate...
                </p>
              ) : (
                <div className="space-y-4">
                  {allTranscripts.map((t, i) => (
                    <div key={i} className="brutalist-border p-4">
                      <p className="text-sm font-black uppercase text-muted-foreground mb-1">
                        {t.speaker} • {formatTime(Math.floor(t.timestamp / 1000))}
                      </p>
                      <p>{t.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Recording Controls */}
          {isMyTurn && (
            <div className="border-t-4 border-foreground p-6 shrink-0 bg-foreground text-background">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-black uppercase">Your Turn to Speak</p>
                  <p className="text-sm opacity-70">
                    {isRecording ? "Recording in progress..." : "Click to start speaking"}
                  </p>
                </div>
                <Button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`brutalist-border px-8 py-6 h-auto uppercase font-black text-lg ${
                    isRecording 
                      ? "bg-destructive text-destructive-foreground border-destructive" 
                      : "bg-background text-foreground"
                  }`}
                >
                  {isRecording ? (
                    <>
                      <MicOff className="h-6 w-6 mr-2" />
                      Stop
                    </>
                  ) : (
                    <>
                      <Mic className="h-6 w-6 mr-2" />
                      Start Speaking
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* POI Button */}
          {session?.status === "in_progress" && !isMyTurn && !isProtected && currentParticipant && (
            <div className="border-t-4 border-foreground p-4 shrink-0">
              <Button
                onClick={() => {
                  socket.offerPoi(0, timer * 1000);
                  setPoiOffered(true);
                  setTimeout(() => setPoiOffered(false), 3000);
                }}
                disabled={poiOffered}
                variant="outline"
                className="brutalist-border bg-transparent uppercase font-black w-full"
              >
                <Hand className="h-5 w-5 mr-2" />
                {poiOffered ? "POI Offered" : "Offer POI"}
              </Button>
            </div>
          )}
        </div>

        {/* Right Panel - Info */}
        <div className="w-80 border-l-4 border-foreground flex flex-col shrink-0">
          <div className="p-4 border-b-4 border-foreground">
            <h3 className="font-black uppercase tracking-wider text-sm">Speaker Order</h3>
          </div>
          <div className="flex-1 p-4 overflow-y-auto">
            <div className="space-y-2">
              {AP_SPEAKER_ORDER.map((role, idx) => {
                const isGov = ['pm', 'dpm', 'gw', 'pmr'].includes(role);
                const isActive = idx === currentSpeakerIndex && session?.status === "in_progress";
                const isDone = idx < currentSpeakerIndex;
                return (
                  <div 
                    key={role}
                    className={`brutalist-border p-3 transition-all ${
                      isActive 
                        ? isGov ? "bg-foreground text-background" : "bg-muted-foreground text-background"
                        : isDone ? "opacity-50" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-black uppercase text-sm">{SPEAKER_NAMES[role]}</p>
                        <p className="text-xs opacity-70">
                          {AP_SPEECH_TIMES[role] / 60} min
                        </p>
                      </div>
                      <span className={`text-xs font-bold uppercase ${
                        isGov ? "" : "opacity-70"
                      }`}>
                        {isGov ? "GOV" : "OPP"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Rules */}
          <div className="p-4 border-t-4 border-foreground">
            <h3 className="font-black uppercase tracking-wider text-sm mb-3">Rules</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>No POIs in protected time (first/last minute)</span>
              </div>
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>No new arguments in reply speeches</span>
              </div>
            </div>
          </div>

          {/* Session Actions */}
          {session?.status === "completed" && (
            <div className="p-4 border-t-4 border-foreground space-y-2">
              <Link href={`/room/${roomCode}/feedback`}>
                <Button className="brutalist-border w-full uppercase font-black">
                  View Feedback
                </Button>
              </Link>
              <Link href={`/room/${roomCode}/mindmap`}>
                <Button variant="outline" className="brutalist-border bg-transparent w-full uppercase font-black">
                  View Mindmap
                </Button>
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
