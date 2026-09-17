import { describe, it, expect } from 'vitest';
import { renderOwnerVoicePreferences, ownerReplyStyle } from '../../src/lib/owner-voice.js';
import { styleFit } from '../../src/lib/idiolect.js';

describe('owner-saved voice preferences', () => {
  it('reads every preference written by Settings, including reply examples', () => {
    const result = renderOwnerVoicePreferences({greeting_style:'Hey lovely!',sign_off_style:'xx',emoji_usage:'none',formality:'casual',key_phrases:['lovely'],avoid:['madam'],few_shot_examples:[{customer:'Private client question',reply:'hiya lovely xx'}]});
    for (const word of ['Hey lovely!','xx','no emoji','casual','lovely','madam','hiya lovely xx']) expect(result).toContain(word);
    expect(result).not.toContain('Private client question');
    expect(result).toContain('never evidence of facts');
  });
  it('does not resurrect a cleared preference from the old field', () => {
    const result = renderOwnerVoicePreferences({greeting_style:'',greetingStyle:'Old greeting',few_shot_examples:[],exampleMessages:['Old reply']});
    expect(result).not.toMatch(/Old greeting|Old reply/);expect(result).toContain('Do not force');
  });
  it('keeps old preferences working and handles an untrained account', () => {
    expect(renderOwnerVoicePreferences({greetingStyle:'hiya',signoffStyle:'x'})).toContain('hiya');
    expect(renderOwnerVoicePreferences(null)).toBe('');expect(renderOwnerVoicePreferences()).toBe('');
    expect(ownerReplyStyle({tone_model:{emoji_usage:'none'}})).toBeNull();
  });
  it('excludes contact or clinical information from voice examples', () => {
    expect(renderOwnerVoicePreferences({few_shot_examples:[{reply:'Email private@customer.invalid about your pregnancy'}]})).toBe('');
  });
  it('does not let measured repairs put removed kisses or emoji back', () => {
    const original={sample_count:30,kiss:{rate:1,token:'xxx'},emoji:{rate_any:1,top:['💕']},lowercase_start_rate:1};
    const owner={voice_profile:{style:original},tone_model:{greeting_style:'Hello',sign_off_style:'',emoji_usage:'none'}};
    const effective=ownerReplyStyle(owner);
    expect(styleFit('Hello lovely 💕 xxx',effective).text).toBe('Hello lovely');
    expect(original.kiss.token).toBe('xxx');expect(original.lowercase_start_rate).toBe(1);
    expect(effective.sample_count).toBe(30);
  });
  it('preserves an explicitly chosen kiss and greeting punctuation', () => {
    const owner={voice_profile:{style:{sample_count:20,kiss:{rate:1,token:'xx'},emoji:{rate_any:0},exclamations:{max:0},lowercase_start_rate:1}},tone_model:{greeting_style:'Hi!',sign_off_style:'x',emoji_usage:'light'}};
    expect(styleFit('Hi! That is fine 💕 xx',ownerReplyStyle(owner)).text).toBe('Hi! That is fine 💕 x');
  });
});
