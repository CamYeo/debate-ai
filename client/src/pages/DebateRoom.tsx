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
  const [interimTranscript, setInterimTranscript] = useState<string>("");
  const [isMicTesting, setIsMicTesting] = useState(false);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [micTestStatus, setMicTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  
  // Mic test refs
  const micTestContextRef = useRef<AudioContext | null>(null);
  const micTestAnalyserRef = useRef<AnalyserNode | null>(null);
  const micTestAnimationRef = useRef<number | null>(null);
  const micTestStreamRef = useRef<MediaStream | null>(null);

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

  // Transcription mutation for server-side Whisper
  const transcribeAudio = trpc.speech.transcribeAudio.useMutation();
  const transcriptionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isRecordingRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  
  // Process audio chunks and send to server for transcription
  const processAudioChunk = useCallback(async () => {
    if (audioChunksRef.current.length === 0) {
      console.log('[Transcribe] No audio chunks to process');
      return;
    }
    
    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    audioChunksRef.current = []; // Clear chunks
    
    // Skip if blob is too small (no real audio)
    if (audioBlob.size < 1000) {
      console.log('[Transcribe] Audio chunk too small, skipping');
      return;
    }
    
    console.log('[Transcribe] Processing audio chunk, size:', audioBlob.size);
    setInterimTranscript('Transcribing...');
    
    try {
      // Convert blob to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await base64Promise;
      
      console.log('[Transcribe] Sending to server, base64 length:', base64Audio.length);
      
      // Send to backend for transcription
      const result = await transcribeAudio.mutateAsync({
        audioData: base64Audio,
        sessionId: roomData?.session?.id || 0,
        speakerRole: currentSpeaker,
        timestamp: timer,
      });
      
      setInterimTranscript('');
      
      if (result.transcript && result.transcript.trim()) {
        console.log('[Transcribe] Got transcript:', result.transcript);
        const newTranscript = {
          speaker: SPEAKER_NAMES[currentSpeaker] || 'Speaker',
          text: result.transcript,
          timestamp: timer * 1000,
        };
        setAllTranscripts(prev => [...prev, newTranscript]);
        
        // Send to other participants via socket
        socket.sendTranscriptUpdate(0, result.transcript, timer * 1000);
        
        toast.success('Transcribed: ' + result.transcript.substring(0, 50) + '...');
      } else {
        console.log('[Transcribe] Empty transcript returned');
      }
    } catch (err: any) {
      console.error('[Transcribe] Error:', err);
      setInterimTranscript('');
      // Don't show error toast for every chunk, just log it
    }
  }, [roomData?.session?.id, currentSpeaker, timer, transcribeAudio, socket]);

  // Recording functions with server-side Whisper transcription
  const startRecording = async () => {
    console.log('[Recording] Starting recording...');
    toast.info('Requesting microphone access...');
    
    try {
      // Request microphone access with optimal settings for speech
      console.log('[Recording] Requesting getUserMedia...');
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        } 
      });
      console.log('[Recording] Microphone access granted!', stream.getAudioTracks());
      streamRef.current = stream;
      
      // Determine best mime type
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/ogg;codecs=opus';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = ''; // Let browser choose
          }
        }
      }
      console.log('[Recording] Using mime type:', mimeType || 'browser default');
      
      const mediaRecorder = mimeType 
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      isRecordingRef.current = true;

      // Set up audio level monitoring with Web Audio API
      const audioContext = new AudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      analyser.minDecibels = -90;
      analyser.maxDecibels = -10;
      microphone.connect(analyser);
      
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      
      // Start monitoring audio levels using time domain data (more accurate for voice)
      const dataArray = new Uint8Array(analyser.fftSize);
      const updateAudioLevel = () => {
        if (analyserRef.current && isRecordingRef.current) {
          analyserRef.current.getByteTimeDomainData(dataArray);
          // Calculate RMS for better audio level detection
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const value = (dataArray[i] - 128) / 128;
            sum += value * value;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          const normalizedLevel = Math.min(100, Math.round(rms * 300));
          setAudioLevel(normalizedLevel);
          animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
        }
      };
      updateAudioLevel();

      // Collect audio chunks
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          console.log('[Recording] Got audio chunk, size:', event.data.size);
          audioChunksRef.current.push(event.data);
          // Also send to other participants
          event.data.arrayBuffer().then(buffer => {
            socket.sendAudioData(buffer);
          });
        }
      };

      // Start recording with 5-second chunks for transcription
      mediaRecorder.start(5000);
      console.log('[Recording] MediaRecorder started with 5s timeslice');
      
      // Set up interval to process and transcribe chunks every 5 seconds
      transcriptionIntervalRef.current = setInterval(() => {
        if (isRecordingRef.current && audioChunksRef.current.length > 0) {
          console.log('[Recording] Processing audio chunks...');
          processAudioChunk();
        }
      }, 5000);
      
      setIsRecording(true);
      socket.startSpeaking(0);
      startTimer();
      
      toast.success('Recording started - speak now!');
      
      if (refereeEnabled) {
        referee.announceSpeaker(currentSpeaker);
      }
    } catch (error: any) {
      console.error('[Recording] Error:', error);
      isRecordingRef.current = false;
      if (error.name === 'NotAllowedError') {
        toast.error("Microphone access denied. Please allow microphone access in your browser settings.");
      } else if (error.name === 'NotFoundError') {
        toast.error("No microphone found. Please connect a microphone and try again.");
      } else if (error.name === 'NotReadableError') {
        toast.error("Microphone is in use by another application.");
      } else {
        toast.error(`Failed to access microphone: ${error.message || 'Unknown error'}`);
      }
    }
  };

  const stopRecording = async () => {
    console.log('[Recording] Stopping recording...');
    isRecordingRef.current = false;
    
    // Clear transcription interval
    if (transcriptionIntervalRef.current) {
      clearInterval(transcriptionIntervalRef.current);
      transcriptionIntervalRef.current = null;
    }
    
    // Stop audio level monitoring
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevel(0);
    
    // Stop media recorder and process final chunk
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      
      // Process any remaining audio chunks
      if (audioChunksRef.current.length > 0) {
        console.log('[Recording] Processing final audio chunks...');
        await processAudioChunk();
      }
    }
    
    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // Clear interim transcript
    setInterimTranscript('');
    
    setIsRecording(false);
    socket.stopSpeaking(0);
    stopTimer();
    
    if (refereeEnabled) {
      referee.announceSpeechEnd(currentSpeaker);
    }
    
    toast.success('Recording stopped');
  };

  // Ref to track mic testing state for closure
  const isMicTestingRef = useRef(false);
  
  // Microphone test functions
  const startMicTest = async () => {
    console.log('[MicTest] Starting microphone test...');
    setMicTestStatus('testing');
    setMicTestLevel(0);
    setIsMicTesting(true);
    isMicTestingRef.current = true;
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micTestStreamRef.current = stream;
      console.log('[MicTest] Microphone access granted!', stream.getAudioTracks());
      
      // Resume audio context if suspended (required by some browsers)
      const audioContext = new AudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      console.log('[MicTest] AudioContext state:', audioContext.state);
      
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3; // Lower smoothing for faster response
      analyser.minDecibels = -90;
      analyser.maxDecibels = -10;
      microphone.connect(analyser);
      
      micTestContextRef.current = audioContext;
      micTestAnalyserRef.current = analyser;
      
      // Monitor audio levels using time domain data (more reliable for voice)
      const dataArray = new Uint8Array(analyser.fftSize);
      let maxLevel = 0;
      
      const updateLevel = () => {
        if (!isMicTestingRef.current || !micTestAnalyserRef.current) {
          return;
        }
        
        // Use time domain data for more accurate voice detection
        micTestAnalyserRef.current.getByteTimeDomainData(dataArray);
        
        // Calculate RMS (root mean square) for better audio level detection
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const value = (dataArray[i] - 128) / 128; // Normalize to -1 to 1
          sum += value * value;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const normalizedLevel = Math.min(100, Math.round(rms * 300)); // Scale up for visibility
        
        setMicTestLevel(normalizedLevel);
        console.log('[MicTest] Audio level:', normalizedLevel, 'RMS:', rms.toFixed(4));
        
        if (normalizedLevel > maxLevel) {
          maxLevel = normalizedLevel;
        }
        
        // If we detect good audio, mark as success
        if (maxLevel > 20) {
          setMicTestStatus('success');
        }
        
        micTestAnimationRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();
      
      toast.success('Microphone connected! Speak to test...');
      
      // Auto-stop after 8 seconds (longer for testing)
      setTimeout(() => {
        if (isMicTestingRef.current) {
          stopMicTest();
        }
      }, 8000);
      
    } catch (error: any) {
      console.error('[MicTest] Error:', error);
      setMicTestStatus('error');
      setIsMicTesting(false);
      isMicTestingRef.current = false;
      
      if (error.name === 'NotAllowedError') {
        toast.error('Microphone access denied. Please allow access in browser settings.');
      } else if (error.name === 'NotFoundError') {
        toast.error('No microphone found. Please connect a microphone.');
      } else {
        toast.error(`Microphone error: ${error.message || 'Unknown error'}`);
      }
    }
  };
  
  const stopMicTest = () => {
    console.log('[MicTest] Stopping microphone test...');
    isMicTestingRef.current = false;
    
    if (micTestAnimationRef.current) {
      cancelAnimationFrame(micTestAnimationRef.current);
      micTestAnimationRef.current = null;
    }
    
    if (micTestContextRef.current) {
      micTestContextRef.current.close();
      micTestContextRef.current = null;
    }
    
    if (micTestStreamRef.current) {
      micTestStreamRef.current.getTracks().forEach(track => track.stop());
      micTestStreamRef.current = null;
    }
    
    micTestAnalyserRef.current = null;
    setIsMicTesting(false);
    
    if (micTestStatus !== 'error') {
      toast.success('Microphone test complete!');
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
  const isAdmin = user?.role === 'admin';
  // In testing mode, allow starting with any participants; otherwise need 6
  const canStart = isCreator && session?.status === "waiting" && (testingMode || participants.length >= 6);
  const isMyTurn = currentParticipant?.speakerRole === currentSpeaker && session?.status === "in_progress";
  // Admin can always speak in testing mode
  const canSpeak = isMyTurn || (testingMode && session?.status === "in_progress" && isAdmin);

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
            {/* Test Microphone Button */}
            <button
              onClick={isMicTesting ? stopMicTest : startMicTest}
              className={`flex items-center gap-2 brutalist-border px-3 py-2 font-black uppercase text-xs transition-colors ${
                isMicTesting 
                  ? 'bg-green-500 text-white border-green-500' 
                  : micTestStatus === 'success'
                  ? 'bg-green-100 text-green-800 border-green-500'
                  : micTestStatus === 'error'
                  ? 'bg-red-100 text-red-800 border-red-500'
                  : 'hover:bg-foreground hover:text-background'
              }`}
            >
              <Mic className={`h-4 w-4 ${isMicTesting ? 'animate-pulse' : ''}`} />
              {isMicTesting ? 'Testing...' : micTestStatus === 'success' ? 'Mic OK' : micTestStatus === 'error' ? 'Mic Error' : 'Test Mic'}
            </button>
            
            {isAdmin && testingMode && (
              <div className="flex items-center gap-2 bg-yellow-500 text-black px-3 py-1">
                <span className="text-xs font-black uppercase">Admin Mode</span>
              </div>
            )}
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

      {/* Microphone Test Indicator */}
      {isMicTesting && (
        <div className="bg-green-500 text-white px-4 py-3">
          <div className="container">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Mic className="h-5 w-5 animate-pulse" />
                <span className="font-black uppercase text-sm">Testing Microphone</span>
                <span className="text-sm opacity-80">Speak now to test your audio...</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase">Level:</span>
                  <div className="w-32 h-4 bg-white/30 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-75 rounded-full ${
                        micTestLevel > 70 ? 'bg-red-400' : 
                        micTestLevel > 30 ? 'bg-white' : 
                        'bg-yellow-300'
                      }`}
                      style={{ width: `${micTestLevel}%` }}
                    />
                  </div>
                  <span className="text-xs font-bold w-8">{micTestLevel}%</span>
                </div>
                <Button
                  onClick={stopMicTest}
                  size="sm"
                  className="bg-white text-green-600 hover:bg-white/90 font-black uppercase text-xs"
                >
                  Stop Test
                </Button>
              </div>
            </div>
            <p className="text-xs mt-2 opacity-80">
              {micTestLevel < 10 ? "No audio detected - check your microphone connection" :
               micTestLevel < 30 ? "Low audio - try speaking louder or moving closer" :
               "Good audio level detected!"}
            </p>
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
            <div className="p-4 border-b-4 border-foreground shrink-0 flex items-center justify-between">
              <h3 className="font-black uppercase tracking-wider text-sm">Live Transcript</h3>
              {isRecording && (
                <div className="flex items-center gap-2 text-sm">
                  <div className="w-2 h-2 bg-destructive rounded-full animate-pulse" />
                  <span className="font-bold uppercase text-destructive">Listening</span>
                </div>
              )}
            </div>
            <div className="flex-1 p-4 overflow-y-auto">
              {allTranscripts.length === 0 && !interimTranscript ? (
                <p className="text-muted-foreground text-center py-12">
                  {isRecording ? "Speak now... listening for your voice" : "Transcripts will appear here during the debate..."}
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
                  {/* Show interim transcript while speaking */}
                  {interimTranscript && (
                    <div className="brutalist-border p-4 border-dashed opacity-70">
                      <p className="text-sm font-black uppercase text-muted-foreground mb-1">
                        {SPEAKER_NAMES[currentSpeaker]} • {formatTime(timer)} (typing...)
                      </p>
                      <p className="italic">{interimTranscript}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Recording Controls - Show for assigned speaker OR admin in testing mode */}
          {canSpeak && (
            <div className="border-t-4 border-foreground p-6 shrink-0 bg-foreground text-background">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-4 mb-2">
                    <p className="font-black uppercase">
                      {isMyTurn ? "Your Turn to Speak" : `Speaking as ${SPEAKER_NAMES[currentSpeaker]}`}
                    </p>
                    {/* Admin speaker role selector */}
                    {isAdmin && testingMode && !isRecording && (
                      <select
                        value={currentSpeakerIndex}
                        onChange={(e) => setCurrentSpeakerIndex(Number(e.target.value))}
                        className="bg-background text-foreground px-3 py-1 font-bold uppercase text-sm border-2 border-background"
                      >
                        {AP_SPEAKER_ORDER.map((role, idx) => (
                          <option key={role} value={idx}>
                            {SPEAKER_NAMES[role]}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <p className="text-sm opacity-70">
                    {isRecording ? "Recording & transcribing..." : "Click to start speaking"}  
                  </p>
                  
                  {/* Audio Level Meter */}
                  {isRecording && (
                    <div className="mt-3">
                      <div className="flex items-center gap-2 mb-1">
                        <Mic className="h-4 w-4" />
                        <span className="text-xs font-bold uppercase">Audio Level</span>
                        <span className="text-xs opacity-70">{audioLevel}%</span>
                      </div>
                      <div className="w-full max-w-xs h-3 bg-background/20 rounded-full overflow-hidden">
                        <div 
                          className={`h-full transition-all duration-75 rounded-full ${
                            audioLevel > 70 ? 'bg-destructive' : 
                            audioLevel > 30 ? 'bg-green-500' : 
                            'bg-yellow-500'
                          }`}
                          style={{ width: `${audioLevel}%` }}
                        />
                      </div>
                      <p className="text-xs opacity-50 mt-1">
                        {audioLevel < 10 ? "No audio detected - check your microphone" :
                         audioLevel < 30 ? "Low audio - speak louder or move closer" :
                         audioLevel > 70 ? "Good audio level!" :
                         "Audio detected"}
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  {isRecording && (
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 bg-destructive rounded-full animate-pulse" />
                      <span className="text-sm font-bold uppercase">Live</span>
                    </div>
                  )}
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
