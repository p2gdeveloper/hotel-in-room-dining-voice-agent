import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { Mic, MicOff, Phone, PhoneOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AudioRecorder, AudioStreamer } from "./lib/audio";
import { motion } from "motion/react";

const apiKey = process.env.GEMINI_API_KEY;
console.log("GEMINI_API_KEY present:", !!apiKey, "length:", apiKey?.length);
const ai = new GoogleGenAI({ apiKey });

const getAdditionalLanguage = () => {
  const val = (import.meta as any).env.VITE_ADDITIONAL_LANGUAGE;
  if (val === undefined) return "Arabic";
  if (typeof val === "string" && ["none", "false", "null", "empty", "no"].includes(val.toLowerCase().trim())) return "";
  return val;
};

export const CONFIG = {
  hotelName: (import.meta as any).env.VITE_HOTEL_NAME || "Fraser Suites Doha",
  greeting: (import.meta as any).env.VITE_GREETING || "Fraser Suites in-room dining, would you like to continue in English or Arabic?",
  additionalLanguage: getAdditionalLanguage(),
  menuWorksheetName: (import.meta as any).env.VITE_MENU_WORKSHEET_NAME || "Menu",
  ordersWorksheetName: (import.meta as any).env.VITE_ORDERS_WORKSHEET_NAME || "Orders",
  voiceName: (import.meta as any).env.VITE_VOICE_NAME || "Zephyr",
};

const MENU = `
${CONFIG.hotelName} In-room Dining Menu

Breakfast:
- English Breakfast (QAR 95.00)
- Arabic Breakfast (QAR 100.00)
- Ful Medames (QAR 45.00)
- Bakery Basket (QAR 45.00)
- Buttermilk Pancake (QAR 45.00)
- Cheese Platter (QAR 45.00)
- Cold Cuts (QAR 40.00)
- 3 Eggs cooked in any style (QAR 45.00)

Starters:
- French Fries (QAR 40.00)
- Chicken Wings (QAR 55.00)
- Hummus (QAR 45.00)
- Mutabal (QAR 45.00)
- Caesar Chicken Salad (QAR 70.00)
- Lentil Soup (QAR 45.00)

Main Courses:
- Fraser Club Sandwich (QAR 70.00)
- Beef Burger (QAR 80.00)
- Penne Arrabiata (QAR 70.00)
- Chicken Biryani (QAR 75.00)
- Grilled Salmon (QAR 135.00)
- Pizza Margherita (QAR 55.00)
- Mixed Arabic Grill (QAR 140.00)

Desserts:
- Cheesecake (QAR 50.00)
- Chocolate Cake (QAR 45.00)
- Fruit Platter (QAR 60.00)
- Tiramisu (QAR 45.00)
- Ice Cream (QAR 35.00)

Drinks:
- Soft Drinks (Coca Cola, Sprite, Fanta) (QAR 25.00)
- Fresh Juices (Orange, Apple, Pineapple) (QAR 40.00)
- Coffee (Espresso, Cappuccino, Latte) (QAR 35.00)
- Tea (English Breakfast, Green Tea, Karak Tea) (QAR 30.00)
`;

const getSystemInstruction = (menu: string) => {
  const languagePrompt = CONFIG.additionalLanguage 
    ? `You are capable of speaking both English and ${CONFIG.additionalLanguage}. If the user chooses or speaks in ${CONFIG.additionalLanguage}, seamlessly switch to that language for the rest of the conversation.`
    : `You will converse only in English.`;

  return `You are a polite, helpful, and to-the-point agent for the In-room dining service of ${CONFIG.hotelName}.
You must initiate the conversation by saying exactly: "${CONFIG.greeting}". Do not wait for the user to speak first.
${languagePrompt}
If the caller is silent for a while after you ask a question, prompt them by asking if they are still there or repeating the question to minimize awkward silences.
Always ask for the room number, saying it back to the caller and request confirmation.
CRITICAL: When a caller confirms their room number, you MUST immediately acknowledge it and tell them to wait (e.g., "Thank you, room 102. Give me just a second while I check for any active orders."). 
You MUST speak this acknowledgment FIRST, and ONLY THEN invoke the manageOrder tool with action="check_status". Do not silently invoke the tool, and do not wait to speak until after the tool returns.
This applies to all actions: Before calling the manageOrder tool for ANY reason, you MUST verbally tell the caller to wait a moment (e.g., "One moment please while I update your order").
If there is already an active order (i.e. not cancelled or expired), ask if they want to add to the order, cancel it, or treat as separate.
If they want to add to the order, use manageOrder with action="update" to update the existing order.
If they want to cancel an unconfirmed order, use manageOrder with action="cancel" to cancel it.
If they are following up on the status of an order, provide the status from the active orders for their room.
Take their order and use the menu to confirm availability. If available, confirm the price. Note that any item marked with "In Stock: No" or similar is unavailable.
CRITICAL: You MUST ONLY suggest, confirm, or add items that are explicitly listed in the provided Menu. NEVER make up items or prices. If a user asks for something not on the menu, politely inform them it is not available and suggest the closest alternative FROM THE MENU.
When a user asks for a type of food (e.g., "sandwiches"), search across ALL categories. Be clever and suggest related items even if the category doesn't match exactly (e.g., suggest wraps, shawarmas, or burgers from "Grilled Meats" if they ask for a sandwich).
When quoting prices, always say "Qatar Riyals" instead of "QAR" (e.g., say "70 Qatar Riyals" instead of "Q.A.R 70.00").
Guide the caller through the menu if they don't have it, intelligently suggesting items based on the time of day or their preferences.
Upsell intelligently based on the conversation flow:
- Offer a drink if they haven't ordered one.
- Offer a dessert if they order a main course/dinner without one.
- However, do NOT offer heavy items like dessert if the caller has indicated they want something light or healthy.
Finally, say that the hotel will endeavor to confirm the order within 30 minutes and if it hasn't, the caller may consider the order expired, with apologies.
When a new order is complete, call the manageOrder function with action="create" to log the call to a Google sheet. IMPORTANT: Only call this ONCE per order. Do not call it again if you have already logged it.
Once the order is completed and you have confirmed there is nothing else the caller needs, call the terminateCall function to end the call.

Menu:
${menu}`;
};

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState<{ role: string; text: string }[]>([]);
  const [orderLogged, setOrderLogged] = useState(false);
  const [liveMenu, setLiveMenu] = useState<string>(MENU);
  const [isLoadingMenu, setIsLoadingMenu] = useState(true);
  
  const sessionRef = useRef<any>(null);
  const streamerRef = useRef<AudioStreamer | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const transcriptRef = useRef(transcript);
  const executedToolCallsRef = useRef<Set<string>>(new Set());
  const isConnectingRef = useRef(false);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    // Fetch the menu from the Google Sheet webhook on load
    const fetchMenu = async () => {
      const webhookUrl = (import.meta as any).env.VITE_GOOGLE_SHEETS_WEBHOOK_URL;
      if (!webhookUrl) {
        setIsLoadingMenu(false);
        return;
      }
      
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=utf-8",
          },
          body: JSON.stringify({ action: "get_menu", sheetName: CONFIG.menuWorksheetName }),
        });
        const data = await response.json();
        
        if (data.status === "success" && data.menu) {
          // Format the menu data into a readable string for the AI
          let formattedMenu = `${CONFIG.hotelName} In-room Dining Menu (Live from Google Sheets)\n\n`;
          
          // Group by category if available
          const categories: Record<string, any[]> = {};
          
          data.menu.forEach((item: any) => {
            const category = item.Category || item.category || "Other";
            if (!categories[category]) categories[category] = [];
            categories[category].push(item);
          });
          
          for (const [category, items] of Object.entries(categories)) {
            formattedMenu += `${category}:\n`;
            items.forEach((item: any) => {
              const englishName = item["English Name"] || item.EnglishName || item.Item || item.item || item.Name || item.name || "Unknown Item";
              const arabicName = item["Arabic Name"] || item.ArabicName || "";
              const price = item["Price (QAR)"] || item.Price || item.price || "N/A";
              const inStock = item["In Stock"] || item.in_stock || item.InStock || item.inStock;
              
              let stockStatus = "";
              if (inStock && inStock.toString().toLowerCase() === "no") {
                stockStatus = " - [UNAVAILABLE / OUT OF STOCK]";
              }
              
              const nameDisplay = arabicName ? `${englishName} / ${arabicName}` : englishName;
              formattedMenu += `- ${nameDisplay} (QAR ${price})${stockStatus}\n`;
            });
            formattedMenu += "\n";
          }
          
          setLiveMenu(formattedMenu);
        }
      } catch (err) {
        console.error("Failed to fetch live menu:", err);
      } finally {
        setIsLoadingMenu(false);
      }
    };
    
    fetchMenu();
  }, []);

  const connect = async () => {
    if (isConnected || isConnectingRef.current) return;
    isConnectingRef.current = true;
    setIsConnecting(true);
    setOrderLogged(false);
    setTranscript([]);
    executedToolCallsRef.current.clear();

    try {
      streamerRef.current = new AudioStreamer();
      recorderRef.current = new AudioRecorder();

      const systemInstruction = getSystemInstruction(liveMenu);

      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: CONFIG.voiceName as any } },
          },
          tools: [{
            functionDeclarations: [{
              name: "manageOrder",
              description: "Manages orders in the Google Sheet. Use check_status to get active orders. Use create to log a new order. Use update to modify an existing order. Use cancel to cancel an order. IMPORTANT: Before calling this tool, you MUST verbally tell the user to wait (e.g., 'Give me a second while I check'). Do not call this tool silently without warning the user first.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING, description: "The action to perform: 'check_status', 'create', 'update', or 'cancel'." },
                  roomNumber: { type: Type.STRING, description: "The guest's room number." },
                  items: { type: Type.ARRAY, items: { type: Type.STRING }, description: "The items ordered (required for create and update)." },
                  totalPrice: { type: Type.NUMBER, description: "The total price of the order (required for create and update)." },
                  orderId: { type: Type.STRING, description: "The ID of the order (required for update and cancel)." }
                },
                required: ["action", "roomNumber"]
              }
            }, {
              name: "terminateCall",
              description: "Terminates the call. Use this when the conversation is over.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  reason: { type: Type.STRING, description: "The reason for terminating the call." }
                }
              }
            }]
          }]
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            
            // Send an initial message to trigger the agent's greeting
            sessionPromise.then((session) => {
              session.sendClientContent({
                turns: [{ role: "user", parts: [{ text: "Hello" }] }],
                turnComplete: true
              });
            });
            
            recorderRef.current?.start((base64Data) => {
              sessionPromise.then((session) => {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            });
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle interruption
            if (message.serverContent?.interrupted) {
              streamerRef.current?.clear();
            }

            // Handle audio output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              streamerRef.current?.addPCM16(base64Audio);
            }

            // Handle tool calls
            const toolCall = message.toolCall;
            if (toolCall) {
              const calls = toolCall.functionCalls;
              if (calls) {
                for (const call of calls) {
                  if (call.id) {
                    if (executedToolCallsRef.current.has(call.id)) continue;
                    executedToolCallsRef.current.add(call.id);
                  }
                  
                  if (call.name === "terminateCall") {
                    console.log("Terminating call:", call.args);
                    sessionPromise.then((session) => {
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { status: "success" }
                        }]
                      });
                      // Disconnect after sending the tool response, waiting for audio to finish
                      const remainingTime = streamerRef.current?.getRemainingTime() || 0;
                      setTimeout(() => disconnect(), remainingTime + 1000);
                    });
                  } else if (call.name === "manageOrder") {
                    
                    const webhookUrl = (import.meta as any).env.VITE_GOOGLE_SHEETS_WEBHOOK_URL;
                    if (webhookUrl) {
                      fetch(webhookUrl, {
                        method: "POST",
                        headers: {
                          "Content-Type": "text/plain;charset=utf-8",
                        },
                        body: JSON.stringify({ ...call.args, sheetName: CONFIG.ordersWorksheetName }),
                      })
                      .then(res => res.json())
                      .then(data => {
                        if (call.args.action === "create") setOrderLogged(true);
                        sessionPromise.then((session) => {
                          session.sendToolResponse({
                            functionResponses: [{
                              id: call.id,
                              name: call.name,
                              response: data
                            }]
                          });
                        });
                      })
                      .catch((err) => {
                        console.error("Failed to manage order in Google Sheets:", err);
                        sessionPromise.then((session) => {
                          session.sendToolResponse({
                            functionResponses: [{
                              id: call.id,
                              name: call.name,
                              response: { status: "error", message: err.toString() }
                            }]
                          });
                        });
                      });
                    } else {
                      // Mock response if no webhook
                      sessionPromise.then((session) => {
                        session.sendToolResponse({
                          functionResponses: [{
                            id: call.id,
                            name: call.name,
                            response: { status: "success", message: "Mock success (no webhook configured)" }
                          }]
                        });
                      });
                    }
                  }
                }
              }
            }
          },
          onclose: (e: any) => {
            console.error("Live API WebSocket closed:", e?.code, e?.reason, e);
            disconnect();
          },
          onerror: (err: any) => {
            console.error("Live API Error:", err?.message || err);
            disconnect();
          }
        }
      });
      
      sessionRef.current = sessionPromise;
      
    } catch (err) {
      console.error("Failed to connect:", err);
      disconnect();
    }
  };

  const disconnect = () => {
    isConnectingRef.current = false;
    setIsConnected(false);
    setIsConnecting(false);
    
    if (recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    if (streamerRef.current) {
      streamerRef.current.stop();
      streamerRef.current = null;
    }
    
    if (sessionRef.current) {
      sessionRef.current.then((session: any) => session.close()).catch(console.error);
      sessionRef.current = null;
    }
  };

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center p-4 font-sans text-stone-900">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-xl overflow-hidden border border-stone-100">
        <div className="p-8 text-center">
          <h1 className="text-2xl font-semibold mb-2 text-stone-800">{CONFIG.hotelName}</h1>
          <p className="text-stone-500 mb-8">In-Room Dining Service</p>
          
          <div className="relative flex justify-center items-center h-48 mb-8">
            {isConnected && (
              <motion.div
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
                className="absolute w-48 h-48 bg-emerald-100 rounded-full opacity-50"
              />
            )}
            {isConnected && (
              <motion.div
                animate={{ scale: [1, 1.5, 1] }}
                transition={{ repeat: Infinity, duration: 2, ease: "easeInOut", delay: 0.5 }}
                className="absolute w-32 h-32 bg-emerald-200 rounded-full opacity-50"
              />
            )}
            
            <button
              onClick={isConnected ? disconnect : connect}
              disabled={isConnecting || isLoadingMenu}
              className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center text-white shadow-lg transition-transform hover:scale-105 active:scale-95 ${
                isConnecting || isLoadingMenu ? 'bg-stone-300 cursor-not-allowed' : isConnected ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-600 hover:bg-emerald-700'
              }`}
            >
              {isConnecting || isLoadingMenu ? (
                <Loader2 className="w-10 h-10 animate-spin" />
              ) : isConnected ? (
                <PhoneOff className="w-10 h-10" />
              ) : (
                <Phone className="w-10 h-10" />
              )}
            </button>
          </div>
          
          <div className="text-sm font-medium text-stone-500 h-6">
            {isLoadingMenu ? "Loading menu..." : isConnecting ? "Connecting..." : isConnected ? "Listening..." : "Tap to call"}
          </div>
        </div>
        
        {orderLogged && (
          <div className="bg-emerald-50 p-4 border-t border-emerald-100 text-emerald-800 text-sm text-center">
            Order successfully logged to Google Sheets!
          </div>
        )}
      </div>
    </div>
  );
}
