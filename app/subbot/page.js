"use client";

import { useState, useEffect, useRef } from 'react';
import { Send, Mic, Trash2, Bot, Loader2 } from 'lucide-react';
import SubscriptionModal from '@/components/SubscriptionModal';
import CouponModal from '@/components/CouponModal';
import { parseJsonResponse } from '@/lib/api-client';
import styles from './page.module.css';

export default function SubBot() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  
  // Modal states
  const [isSubModalOpen, setIsSubModalOpen] = useState(false);
  const [subModalData, setSubModalData] = useState(null);
  const [isCouponModalOpen, setIsCouponModalOpen] = useState(false);
  const [couponModalData, setCouponModalData] = useState(null);
  
  // Local contexts to reference in client
  const [subscriptions, setSubscriptions] = useState([]);
  const [coupons, setCoupons] = useState([]);
  
  // Pending operations (delete confirm)
  const [pendingDelete, setPendingDelete] = useState(null); // { type: 'subscription'|'coupon', id, name }

  const chatEndRef = useRef(null);
  const recognitionRef = useRef(null);

  // Fetch local data for validation / editing context
  const fetchData = async () => {
    try {
      const [subsRes, couponsRes] = await Promise.all([
        fetch('/api/subscriptions'),
        fetch('/api/coupons')
      ]);
      if (subsRes.ok) {
        const subsData = await parseJsonResponse(subsRes, '/api/subscriptions');
        setSubscriptions(subsData);
      }
      if (couponsRes.ok) {
        const couponsData = await parseJsonResponse(couponsRes, '/api/coupons');
        setCoupons(couponsData);
      }
    } catch (e) {
      console.warn("Failed to fetch contextual data:", e);
    }
  };

  useEffect(() => {
    fetchData();
    // Load state from sessionStorage
    try {
      const savedMessages = sessionStorage.getItem('subbot_chat_history');
      if (savedMessages) {
        setMessages(JSON.parse(savedMessages));
      }
      const savedInput = sessionStorage.getItem('subbot_chat_input');
      if (savedInput) {
        setInput(savedInput);
      }
      const savedPendingDelete = sessionStorage.getItem('subbot_pending_delete');
      if (savedPendingDelete) {
        setPendingDelete(JSON.parse(savedPendingDelete));
      }
    } catch (e) {
      console.error("Failed to load SubBot state from sessionStorage:", e);
    }
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem('subbot_chat_history', JSON.stringify(messages));
    } catch (_) {}
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    try {
      sessionStorage.setItem('subbot_chat_input', input);
    } catch (_) {}
  }, [input]);

  useEffect(() => {
    try {
      if (pendingDelete) {
        sessionStorage.setItem('subbot_pending_delete', JSON.stringify(pendingDelete));
      } else {
        sessionStorage.removeItem('subbot_pending_delete');
      }
    } catch (_) {}
  }, [pendingDelete]);

  // Speech Recognition setup
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        const rec = new SpeechRecognition();
        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = 'en-IN';
        
        rec.onstart = () => {
          setIsListening(true);
        };
        rec.onerror = (e) => {
          console.error("Speech Recognition Error Event details:", {
            error: e.error,
            message: e.message,
            type: e.type,
            event: e
          });
          
          setIsListening(false);
          
          let userFriendlyMsg = "Voice recognition error occurred. Please try again.";
          const errType = e.error;
          
          if (errType === 'network') {
            userFriendlyMsg = "Voice recognition encountered a temporary network issue. Please try again.";
          } else if (errType === 'not-allowed') {
            userFriendlyMsg = "Microphone permission was denied. Please enable microphone access in your browser settings.";
          } else if (errType === 'no-speech') {
            userFriendlyMsg = "No speech was detected. Please try speaking again.";
          } else if (errType === 'audio-capture') {
            userFriendlyMsg = "Audio capture failed. Ensure your microphone is plugged in and configured correctly.";
          } else if (errType === 'aborted') {
            userFriendlyMsg = "Voice input was stopped.";
          } else if (errType === 'service-not-allowed') {
            userFriendlyMsg = "Speech recognition service is not allowed or supported.";
          }
          
          setMessages(prev => [...prev, {
            id: Date.now() + 10,
            role: 'assistant',
            content: `**Voice Input Alert:** ${userFriendlyMsg}`
          }]);
        };
        rec.onend = () => {
          setIsListening(false);
        };
        rec.onresult = (event) => {
          const text = event.results[0][0].transcript;
          if (text) {
            setInput(text);
            handleSendMessage(text);
          }
        };
        recognitionRef.current = rec;
      }
    }
  }, []);

  const handleMicClick = () => {
    if (!recognitionRef.current) {
      setMessages(prev => [...prev, {
        id: Date.now() + 10,
        role: 'assistant',
        content: `**Voice Input Alert:** Web Speech Recognition is not supported in this browser. Please try Google Chrome or Microsoft Edge.`
      }]);
      return;
    }
    if (isListening) {
      try {
        recognitionRef.current.stop();
      } catch (err) {
        console.error("Error stopping recognition:", err);
      }
      setIsListening(false);
    } else {
      try {
        recognitionRef.current.start();
      } catch (err) {
        console.error("Error starting recognition:", err);
        setIsListening(false);
      }
    }
  };

  const clearChat = () => {
    if (confirm("Are you sure you want to clear this conversation?")) {
      setMessages([]);
      setInput('');
      setPendingDelete(null);
      try {
        sessionStorage.removeItem('subbot_chat_history');
        sessionStorage.removeItem('subbot_chat_input');
        sessionStorage.removeItem('subbot_pending_delete');
        localStorage.removeItem('subbot_chat_history');
      } catch (_) {}
    }
  };

  const handleSendMessage = async (textToSend) => {
    const text = (textToSend || input).trim();
    if (!text) return;

    setInput('');
    setPendingDelete(null);
    
    // Add user message
    const userMsgId = Date.now();
    const newMessages = [...messages, { id: userMsgId, role: 'user', content: text }];
    setMessages(newMessages);
    setLoading(true);

    try {
      // Build history context (last 10 messages to limit prompt size)
      const formattedHistory = messages.slice(-10).map(m => ({
        role: m.role,
        content: m.content
      }));

      // Call server-side API
      const res = await fetch('/api/subbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: formattedHistory
        })
      });

      if (!res.ok) {
        throw new Error(`API returned status ${res.status}`);
      }

      const data = await res.json();
      const replyText = data.reply || "I didn't receive a reply from the AI service.";
      
      const assistantMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        content: replyText,
        action: data.action || null,
        options: data.options || null,
        coachReport: data.coachReport || null
      };

      setMessages(prev => [...prev, assistantMsg]);
      
      // If there is an action, handle it
      if (data.action) {
        handleAIAction(data.action);
      }
    } catch (e) {
      console.error(e);
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'assistant',
        content: `⚠️ Error communicating with SubBot: ${e.message}. Please check your connection and configuration.`
      }]);
    } finally {
      setLoading(false);
    }
  };

  const sanitizeSubData = (data) => {
    if (!data) return null;
    return {
      name: data.name || '',
      category: data.category || 'Entertainment',
      cost: data.cost !== null && data.cost !== undefined ? data.cost : '',
      billingCycle: data.billingCycle || 'monthly',
      renewalDate: data.renewalDate || '',
      url: data.url || '',
      notes: data.notes || '',
      autopayEnabled: data.autopayEnabled ?? false,
      couponId: data.couponId || null,
      couponCode: data.couponCode || null,
      couponDiscount: data.couponDiscount || null
    };
  };

  const sanitizeCouponData = (data) => {
    if (!data) return null;
    return {
      code: data.code || '',
      discount: data.discount || '',
      service: data.service || '',
      expiryDate: data.expiryDate || '',
      description: data.description || ''
    };
  };

  const handleAIAction = (action) => {
    const { type } = action;
    const rawData = action.data || {};
    
    const data = type === 'add_subscription' || type === 'edit_subscription' || type === 'apply_best_coupon'
      ? sanitizeSubData(rawData)
      : (type === 'add_coupon' || type === 'edit_coupon' ? sanitizeCouponData(rawData) : rawData);

    if (type === 'add_subscription') {
      // Pre-fill SubscriptionModal (without subscription.id)
      setSubModalData(data);
      setIsSubModalOpen(true);
    } 
    else if (type === 'edit_subscription') {
      // Find subscription ID by searching local subscriptions
      const nameToFind = data.name || '';
      const existing = subscriptions.find(s => s.name.toLowerCase() === nameToFind.toLowerCase() || s.id === data.id);
      
      if (existing) {
        // Pre-fill with existing ID so it PUTs
        setSubModalData(sanitizeSubData({
          ...existing,
          ...data,
          id: existing.id // Keep the same ID
        }));
        setIsSubModalOpen(true);
      } else {
        // Fallback: search failed, open as a new subscription
        setSubModalData(data);
        setIsSubModalOpen(true);
      }
    }
    else if (type === 'delete_subscription') {
      const nameToFind = data.name || '';
      const existing = subscriptions.find(s => s.name.toLowerCase() === nameToFind.toLowerCase() || s.id === data.id);
      
      if (existing) {
        setPendingDelete({
          type: 'subscription',
          id: existing.id,
          name: existing.name
        });
      } else {
        setMessages(prev => [...prev, {
          id: Date.now() + 2,
          role: 'assistant',
          content: `Could not locate an active subscription named "${nameToFind}" to delete.`
        }]);
      }
    }
    else if (type === 'add_coupon') {
      setCouponModalData(data);
      setIsCouponModalOpen(true);
    }
    else if (type === 'edit_coupon') {
      const codeToFind = data.code || '';
      const existing = coupons.find(c => c.code.toLowerCase() === codeToFind.toLowerCase() || c.id === data.id);
      if (existing) {
        setCouponModalData(sanitizeCouponData({
          ...existing,
          ...data,
          id: existing.id
        }));
        setIsCouponModalOpen(true);
      } else {
        setCouponModalData(data);
        setIsCouponModalOpen(true);
      }
    }
    else if (type === 'delete_coupon') {
      const codeToFind = data.code || '';
      const existing = coupons.find(c => c.code.toLowerCase() === codeToFind.toLowerCase() || c.id === data.id);
      if (existing) {
        setPendingDelete({
          type: 'coupon',
          id: existing.id,
          name: existing.code
        });
      } else {
        setMessages(prev => [...prev, {
          id: Date.now() + 2,
          role: 'assistant',
          content: `Could not locate a coupon with code "${codeToFind}" to delete.`
        }]);
      }
    }
    else if (type === 'apply_best_coupon') {
      const subId = rawData.subscriptionId;
      const coupId = rawData.couponId;
      
      const sub = subscriptions.find(s => s.id === subId);
      const coupon = coupons.find(c => c.id === coupId);
      
      if (sub && coupon) {
        // Open Edit Subscription modal with pre-selected coupon details!
        setSubModalData(sanitizeSubData({
          ...sub,
          couponId: coupon.id,
          couponCode: coupon.code,
          couponDiscount: coupon.discount
        }));
        setIsSubModalOpen(true);
      }
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const { type, id, name } = pendingDelete;
    setLoading(true);

    try {
      const url = type === 'subscription' ? `/api/subscriptions/${id}` : `/api/coupons/${id}`;
      const res = await fetch(url, { method: 'DELETE' });
      await parseJsonResponse(res, url);

      setMessages(prev => [...prev, {
        id: Date.now() + 3,
        role: 'assistant',
        content: `✅ Successfully deleted the ${type}: **${name}**.`
      }]);
      
      setPendingDelete(null);
      fetchData(); // Refresh list
    } catch (e) {
      console.error(e);
      setMessages(prev => [...prev, {
        id: Date.now() + 3,
        role: 'assistant',
        content: `⚠️ Failed to delete ${type}: ${e.message}`
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleCancelDelete = () => {
    setMessages(prev => [...prev, {
      id: Date.now() + 4,
      role: 'assistant',
      content: `Deletion of **${pendingDelete.name}** canceled.`
    }]);
    setPendingDelete(null);
  };

  // Rendering helpers
  const formatMessageContent = (text) => {
    if (!text) return '';
    const lines = text.split('\n');
    return lines.map((line, i) => {
      let cleanLine = line;
      // Bold
      cleanLine = cleanLine.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      // Code
      cleanLine = cleanLine.replace(/`(.*?)`/g, '<code>$1</code>');
      
      // Bullets
      if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
        const content = cleanLine.trim().substring(2);
        return <li key={i} dangerouslySetInnerHTML={{ __html: content }} />;
      }
      
      // Headings
      if (line.startsWith('### ')) {
        return <h4 key={i} className={styles.msgH4} style={{ color: 'var(--secondary)', marginTop: '0.5rem', marginBottom: '0.25rem' }} dangerouslySetInnerHTML={{ __html: cleanLine.substring(4) }} />;
      }
      if (line.startsWith('## ')) {
        return <h3 key={i} className={styles.msgH3} style={{ color: 'var(--primary)', marginTop: '0.75rem', marginBottom: '0.35rem' }} dangerouslySetInnerHTML={{ __html: cleanLine.substring(3) }} />;
      }
      
      // Blockquote
      if (line.startsWith('> ')) {
        return <blockquote key={i} style={{ borderLeft: '3px solid var(--primary)', background: 'rgba(122, 162, 247, 0.05)', padding: '0.5rem 0.75rem', margin: '0.5rem 0', fontStyle: 'italic', borderRadius: '0 var(--radius-sm) var(--radius-sm) 0' }} dangerouslySetInnerHTML={{ __html: cleanLine.substring(2) }} />;
      }

      if (line.trim() === '') {
        return <br key={i} />;
      }

      return <p key={i} dangerouslySetInnerHTML={{ __html: cleanLine }} />;
    });
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1>🤖 SubBot</h1>
          <p>Your natural language assistant for digital subscriptions.</p>
        </div>
        {messages.length > 0 && (
          <button onClick={clearChat} className={styles.clearBtn} title="Clear conversation">
            <Trash2 size={16} />
            Clear
          </button>
        )}
      </header>

      <div className={styles.chatWrapper}>
        <div className={styles.chatArea}>
          {messages.length === 0 ? (
            <div className={styles.greetingContainer}>
              {/* Hero Section */}
              <div className={styles.coachHero}>
                <h2>🤖 AI Smart Subscription Coach</h2>
                <div className={styles.coachHeroSubtitle}>Your personal AI financial advisor for subscriptions.</div>
                <p className={styles.coachHeroDesc}>
                  Tell me your financial goal and I'll create the best plan to reduce your subscription expenses while keeping the services that matter most.
                </p>
                <button
                  type="button"
                  onClick={() => handleSendMessage("Let's start the AI Subscription Coach planning session.")}
                  className={styles.coachHeroBtn}
                >
                  Start Planning
                </button>
              </div>

              {/* Quick Action Cards */}
              <div className={styles.suggestedPrompts}>
                <button 
                  type="button"
                  onClick={() => { handleSendMessage("Help me reduce my monthly spending."); }}
                  className={styles.suggestedPromptCard}
                >
                  <strong>🎯 Reduce My Monthly Spending</strong>
                  <span>Help me reduce my monthly spending.</span>
                </button>
                <button 
                  type="button"
                  onClick={() => { handleSendMessage("Help me stay under a monthly budget."); }}
                  className={styles.suggestedPromptCard}
                >
                  <strong>💰 Stay Under My Budget</strong>
                  <span>Help me stay under a monthly budget.</span>
                </button>
                <button 
                  type="button"
                  onClick={() => { handleSendMessage("Find subscriptions that provide the least value."); }}
                  className={styles.suggestedPromptCard}
                >
                  <strong>📊 Optimize My Subscriptions</strong>
                  <span>Find subscriptions that provide the least value.</span>
                </button>
                <button 
                  type="button"
                  onClick={() => { handleSendMessage("Analyze my coupon vault and recommend the best coupon savings strategy."); }}
                  className={styles.suggestedPromptCard}
                >
                  <strong>🎟️ Coupon Savings Strategy</strong>
                  <span>Analyze my coupon vault and recommend savings.</span>
                </button>
                <button 
                  type="button"
                  onClick={() => { handleSendMessage("Create a renewal optimization planner for the next 30 days."); }}
                  className={styles.suggestedPromptCard}
                >
                  <strong>📅 Renewal Planner</strong>
                  <span>Create a renewal optimization planner.</span>
                </button>
                <button 
                  type="button"
                  onClick={() => { handleSendMessage("Analyze my spending patterns and give me optimization recommendations."); }}
                  className={styles.suggestedPromptCard}
                >
                  <strong>📈 Analyze My Spending</strong>
                  <span>Analyze spending patterns and recommend fixes.</span>
                </button>
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`${styles.messageRow} ${msg.role === 'user' ? styles.messageRowUser : styles.messageRowAssistant}`}
                style={{ flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: '0.5rem' }}
              >
                <div className={`${styles.messageBubble} ${msg.role === 'user' ? styles.messageBubbleUser : styles.messageBubbleAssistant}`}>
                  {msg.role === 'user' ? msg.content : formatMessageContent(msg.content)}
                </div>

                {msg.role === 'assistant' && msg.coachReport && (
                  <CoachReportPanel report={msg.coachReport} onApply={handleAIAction} />
                )}

                {msg.role === 'assistant' && msg.options && (
                  <div className={styles.optionsContainer}>
                    {msg.options.map((opt, oIdx) => (
                      <button 
                        key={oIdx} 
                        type="button"
                        onClick={() => handleSendMessage(opt)} 
                        className={styles.optionBtn}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}

          {pendingDelete && (
            <div className={styles.messageRow} style={{ justifyContent: 'flex-start' }}>
              <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`} style={{ borderColor: 'var(--danger)' }}>
                <p>⚠️ <strong>Confirm Deletion:</strong> Are you sure you want to delete the {pendingDelete.type} **{pendingDelete.name}**?</p>
                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
                  <button 
                    onClick={handleConfirmDelete} 
                    style={{ background: 'var(--danger)', color: '#0d0e12', fontWeight: 600, padding: '0.4rem 1rem', borderRadius: '4px', fontSize: '0.85rem' }}
                  >
                    Yes, Delete
                  </button>
                  <button 
                    onClick={handleCancelDelete} 
                    style={{ background: 'var(--surface-accent)', color: 'var(--text-primary)', padding: '0.4rem 1rem', borderRadius: '4px', fontSize: '0.85rem', border: '1px solid var(--border)' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {loading && (
            <div className={styles.messageRow} style={{ justifyContent: 'flex-start' }}>
              <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`} style={{ width: 'fit-content' }}>
                <div className={styles.typingIndicator}>
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <form 
          onSubmit={(e) => { e.preventDefault(); handleSendMessage(); }} 
          className={styles.inputForm}
        >
          <button 
            type="button"
            onClick={handleMicClick}
            className={`${styles.iconBtn} ${styles.micBtn} ${isListening ? styles.micBtnActive : ''}`}
            title={isListening ? "Listening..." : "Voice input"}
          >
            <Mic size={18} />
          </button>
          
          <input 
            type="text" 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask SubBot to add/edit/delete subscriptions or coupons, recommend coupons..."
            className={styles.textInput}
            disabled={loading}
          />
          
          <button 
            type="submit" 
            disabled={loading || !input.trim()} 
            className={`${styles.iconBtn} ${styles.sendBtn}`}
            title="Send message"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
          </button>
        </form>
      </div>

      {/* Subscription Modal Overlays */}
      {isSubModalOpen && (
        <SubscriptionModal
          subscription={subModalData}
          onClose={() => { setIsSubModalOpen(false); setSubModalData(null); }}
          onSave={() => {
            fetchData();
            setMessages(prev => [...prev, {
              id: Date.now() + 5,
              role: 'assistant',
              content: `✅ Subscription details saved successfully.`
            }]);
          }}
        />
      )}

      {/* Coupon Modal Overlays */}
      {isCouponModalOpen && (
        <CouponModal
          coupon={couponModalData}
          onClose={() => { setIsCouponModalOpen(false); setCouponModalData(null); }}
          onSave={() => {
            fetchData();
            setMessages(prev => [...prev, {
              id: Date.now() + 5,
              role: 'assistant',
              content: `✅ Coupon details saved successfully.`
            }]);
          }}
        />
      )}
    </div>
  );
}

function CoachReportPanel({ report, onApply }) {
  if (!report) return null;

  const current = parseFloat(report.currentSpending) || 0;
  const projected = parseFloat(report.projectedSpending) || 0;
  
  const currentPct = 100;
  const projectedPct = current > 0 ? Math.min(100, Math.round((projected / current) * 100)) : 0;

  return (
    <div className={styles.coachReport}>
      <div className={styles.coachGoal}>
        <span className={styles.coachGoalIcon}>🎯</span>
        <div>
          <h3>Your Optimization Goal</h3>
          <p>{report.goal || "Optimize digital subscriptions"}</p>
        </div>
      </div>

      <div className={styles.coachOverviewGrid}>
        <div className={styles.coachMetric}>
          <span className={styles.coachMetricLabel}>Current Monthly Spend</span>
          <span className={styles.coachMetricValue}>₹{current.toFixed(2)}</span>
        </div>
        <div className={styles.coachMetric}>
          <span className={styles.coachMetricLabel}>Projected Monthly Spend</span>
          <span className={`${styles.coachMetricValue} ${styles.optimized}`}>₹{projected.toFixed(2)}</span>
        </div>
        <div className={styles.coachMetric}>
          <span className={styles.coachMetricLabel}>Est. Monthly Saving</span>
          <span className={`${styles.coachMetricValue} ${styles.saving}`}>₹{(parseFloat(report.estimatedMonthlySaving) || 0).toFixed(2)}</span>
        </div>
        <div className={styles.coachMetric}>
          <span className={styles.coachMetricLabel}>Est. Yearly Saving</span>
          <span className={`${styles.coachMetricValue} ${styles.saving}`}>₹{(parseFloat(report.estimatedYearlySaving) || 0).toFixed(2)}</span>
        </div>
      </div>

      {/* Progress Comparison */}
      <div className={styles.coachProgressSection}>
        <h4>Spending Comparison</h4>
        <div className={styles.progressBarWrapper}>
          <span className={styles.progressLabel}>Current Spending</span>
          <div className={styles.progressTrack}>
            <div className={`${styles.progressBar} ${styles.currentBar}`} style={{ width: `${currentPct}%` }}>
              <span>₹{current.toFixed(2)}</span>
            </div>
          </div>
        </div>
        <div className={styles.progressBarWrapper}>
          <span className={styles.progressLabel}>Optimized Spending</span>
          <div className={styles.progressTrack}>
            <div className={`${styles.progressBar} ${styles.projectedBar}`} style={{ width: `${projectedPct}%` }}>
              <span>₹{projected.toFixed(2)}</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          <span>Monthly Saving: ₹{(parseFloat(report.estimatedMonthlySaving) || 0).toFixed(2)}</span>
          <span>Yearly Saving: ₹{(parseFloat(report.estimatedYearlySaving) || 0).toFixed(2)}</span>
        </div>
      </div>

      {/* Recommended Actions */}
      <div className={styles.coachRecSection}>
        <h4>Recommended Actions ({report.recommendations?.length || 0})</h4>
        <div className={styles.recGrid}>
          {report.recommendations?.map((rec, index) => {
            const confClass = styles[`conf${rec.confidence || 'High'}`];
            return (
              <div key={index} className={styles.recCard}>
                <div className={styles.recCardHeader}>
                  <span className={styles.recCardTitle}>{rec.title || "Optimize Subscription"}</span>
                  <span className={`${styles.recConfidence} ${confClass}`}>{rec.confidence || "High"} Confidence</span>
                </div>
                <div className={styles.recCardBody}>
                  <div className={styles.recTargetDetail}>
                    <span className={styles.recTargetName}>{rec.targetName || "Service"}</span>
                    <span className={styles.recSaving}>Saves {rec.saving}</span>
                  </div>
                  <p className={styles.recReason}><strong>Reason:</strong> {rec.reason}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onApply({ type: rec.type, data: rec.actionData })}
                  className={styles.recApplyBtn}
                >
                  Apply Recommendation
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
