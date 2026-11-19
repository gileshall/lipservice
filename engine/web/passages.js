// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Long passages for the Speak tab, each as plain text and as SSML. All public domain. A blank line
// (plain) or a <p> (SSML) ends a paragraph, and the engine says a text a paragraph at a time.

export const PASSAGES = [
  {
    name: "Gettysburg Address",
    plain: `Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal.

Now we are engaged in a great civil war, testing whether that nation, or any nation so conceived and so dedicated, can long endure. We are met on a great battle-field of that war.

We have come to dedicate a portion of that field, as a final resting place for those who here gave their lives that that nation might live. It is altogether fitting and proper that we should do this.

But, in a larger sense, we can not dedicate, we can not consecrate, we can not hallow, this ground. The brave men, living and dead, who struggled here, have consecrated it, far above our poor power to add or detract.

The world will little note, nor long remember what we say here, but it can never forget what they did here. It is for us the living, rather, to be dedicated here to the unfinished work which they who fought here have thus far so nobly advanced.

It is rather for us to be here dedicated to the great task remaining before us, that from these honored dead we take increased devotion to that cause for which they gave the last full measure of devotion, that we here highly resolve that these dead shall not have died in vain, that this nation, under God, shall have a new birth of freedom, and that government of the people, by the people, for the people, shall not perish from the earth.`,
    ssml: `<speak>
<p><prosody rate="0.92">Four score and seven years ago our fathers brought forth on this continent, <break time="250ms"/>a new nation, conceived in Liberty, and dedicated to the proposition that <emphasis>all</emphasis> men are created equal.</prosody></p>
<p>Now we are engaged in a great civil war, <break time="200ms"/>testing whether that nation, or <emphasis>any</emphasis> nation so conceived and so dedicated, <break time="200ms"/>can long endure. We are met on a great battle-field of that war.</p>
<p>We have come to dedicate a portion of that field, as a final resting place for those who here gave their lives that that nation might live. <break time="300ms"/>It is altogether fitting and proper that we should do this.</p>
<p>But, <break time="200ms"/>in a larger sense, <break time="300ms"/>we can not <emphasis>dedicate</emphasis>, <break time="200ms"/>we can not <emphasis>consecrate</emphasis>, <break time="200ms"/>we can not <emphasis>hallow</emphasis>, this ground. The brave men, living and dead, who struggled here, have consecrated it, far above our poor power to add or detract.</p>
<p>The world will little note, nor long remember what we say here, <break time="200ms"/>but it can <emphasis level="strong">never</emphasis> forget what they did here. It is for us the living, rather, to be dedicated here to the unfinished work which they who fought here have thus far so nobly advanced.</p>
<p><prosody rate="0.9">It is rather for us to be here dedicated to the great task remaining before us, <break time="250ms"/>that from these honored dead we take increased devotion to that cause for which they gave the last full measure of devotion, <break time="250ms"/>that we here highly resolve that these dead shall not have died in vain, <break time="250ms"/>that this nation, under God, shall have a new birth of freedom, <break time="300ms"/>and that government <emphasis>of</emphasis> the people, <break time="150ms"/><emphasis>by</emphasis> the people, <break time="150ms"/><emphasis>for</emphasis> the people, <break time="300ms"/><prosody rate="0.85" pitch="-1st">shall not perish from the earth.</prosody></prosody></p>
</speak>`,
  },
  {
    name: "Second Inaugural",
    plain: `Fellow-Countrymen:

At this second appearing to take the oath of the Presidential office there is less occasion for an extended address than there was at the first. Then a statement somewhat in detail of a course to be pursued seemed fitting and proper.

Now, at the expiration of four years, during which public declarations have been constantly called forth on every point and phase of the great contest which still absorbs the attention and engrosses the energies of the nation, little that is new could be presented.

The progress of our arms, upon which all else chiefly depends, is as well known to the public as to myself, and it is, I trust, reasonably satisfactory and encouraging to all. With high hope for the future, no prediction in regard to it is ventured.

On the occasion corresponding to this four years ago all thoughts were anxiously directed to an impending civil war. All dreaded it, all sought to avert it.

While the inaugural address was being delivered from this place, devoted altogether to saving the Union without war, insurgent agents were in the city seeking to destroy it without war, seeking to dissolve the Union and divide effects by negotiation.

Both parties deprecated war, but one of them would make war rather than let the nation survive, and the other would accept war rather than let it perish. And the war came.

One-eighth of the whole population were colored slaves, not distributed generally over the Union, but localized in the southern part of it. These slaves constituted a peculiar and powerful interest. All knew that this interest was somehow the cause of the war.

To strengthen, perpetuate, and extend this interest was the object for which the insurgents would rend the Union even by war, while the Government claimed no right to do more than to restrict the territorial enlargement of it.

Neither party expected for the war the magnitude or the duration which it has already attained. Neither anticipated that the cause of the conflict might cease with or even before the conflict itself should cease. Each looked for an easier triumph, and a result less fundamental and astounding.

Both read the same Bible and pray to the same God, and each invokes His aid against the other. It may seem strange that any men should dare to ask a just God's assistance in wringing their bread from the sweat of other men's faces, but let us judge not, that we be not judged.

The prayers of both could not be answered. That of neither has been answered fully. The Almighty has His own purposes. "Woe unto the world because of offenses; for it must needs be that offenses come, but woe to that man by whom the offense cometh."

If we shall suppose that American slavery is one of those offenses which, in the providence of God, must needs come, but which, having continued through His appointed time, He now wills to remove, and that He gives to both North and South this terrible war as the woe due to those by whom the offense came, shall we discern therein any departure from those divine attributes which the believers in a living God always ascribe to Him?

Fondly do we hope, fervently do we pray, that this mighty scourge of war may speedily pass away. Yet, if God wills that it continue until all the wealth piled by the bondsman's two hundred and fifty years of unrequited toil shall be sunk, and until every drop of blood drawn with the lash shall be paid by another drawn with the sword, as was said three thousand years ago, so still it must be said "the judgments of the Lord are true and righteous altogether."

With malice toward none, with charity for all, with firmness in the right as God gives us to see the right, let us strive on to finish the work we are in, to bind up the nation's wounds, to care for him who shall have borne the battle and for his widow and his orphan, to do all which may achieve and cherish a just and lasting peace among ourselves and with all nations.`,
    ssml: `<speak>
<p>Fellow-Countrymen: <break time="500ms"/>At this second appearing to take the oath of the Presidential office there is less occasion for an extended address than there was at the first. Then a statement somewhat in detail of a course to be pursued seemed fitting and proper.</p>
<p>Now, <break time="200ms"/>at the expiration of four years, during which public declarations have been constantly called forth on every point and phase of the great contest which still absorbs the attention and engrosses the energies of the nation, <break time="250ms"/>little that is new could be presented.</p>
<p>The progress of our arms, upon which all else chiefly depends, is as well known to the public as to myself, and it is, <break time="150ms"/>I trust, <break time="150ms"/>reasonably satisfactory and encouraging to all. With high hope for the future, no prediction in regard to it is ventured.</p>
<p>On the occasion corresponding to this four years ago all thoughts were anxiously directed to an impending civil war. <emphasis>All</emphasis> dreaded it, <break time="150ms"/><emphasis>all</emphasis> sought to avert it.</p>
<p>While the inaugural address was being delivered from this place, devoted altogether to <emphasis>saving</emphasis> the Union without war, <break time="200ms"/>insurgent agents were in the city seeking to <emphasis>destroy</emphasis> it without war, <break time="200ms"/>seeking to dissolve the Union and divide effects by negotiation.</p>
<p>Both parties deprecated war, <break time="200ms"/>but one of them would <emphasis>make</emphasis> war rather than let the nation survive, <break time="200ms"/>and the other would <emphasis>accept</emphasis> war rather than let it perish. <break time="600ms"/><prosody rate="0.8" pitch="-2st">And the war came.</prosody></p>
<p>One-eighth of the whole population were colored slaves, not distributed generally over the Union, but localized in the southern part of it. These slaves constituted a peculiar and powerful interest. All knew that this interest was <emphasis>somehow</emphasis> the cause of the war.</p>
<p>To strengthen, <break time="100ms"/>perpetuate, <break time="100ms"/>and extend this interest was the object for which the insurgents would rend the Union even by war, <break time="200ms"/>while the Government claimed no right to do more than to restrict the territorial enlargement of it.</p>
<p>Neither party expected for the war the magnitude or the duration which it has already attained. Neither anticipated that the cause of the conflict might cease with or even before the conflict itself should cease. Each looked for an easier triumph, and a result less fundamental and astounding.</p>
<p>Both read the same Bible and pray to the same God, and each invokes His aid against the other. It may seem strange that any men should dare to ask a just God's assistance in wringing their bread from the sweat of other men's faces, <break time="300ms"/><prosody rate="0.9">but let us judge not, that we be not judged.</prosody></p>
<p>The prayers of both could not be answered. That of neither has been answered fully. <break time="300ms"/>The Almighty has His own purposes. <break time="300ms"/><prosody rate="0.9" pitch="-1st">Woe unto the world because of offenses; for it must needs be that offenses come, but woe to that man by whom the offense cometh.</prosody></p>
<p>If we shall suppose that American slavery is one of those offenses which, in the providence of God, must needs come, but which, having continued through His appointed time, He now wills to remove, <break time="250ms"/>and that He gives to both North and South this terrible war as the woe due to those by whom the offense came, <break time="300ms"/>shall we discern therein any departure from those divine attributes which the believers in a living God always ascribe to Him?</p>
<p><prosody volume="soft" rate="0.9">Fondly do we hope, <break time="200ms"/>fervently do we pray, <break time="200ms"/>that this mighty scourge of war may speedily pass away.</prosody> <break time="500ms"/>Yet, if God wills that it continue until all the wealth piled by the bondsman's two hundred and fifty years of unrequited toil shall be sunk, <break time="200ms"/>and until every drop of blood drawn with the lash shall be paid by another drawn with the sword, <break time="250ms"/>as was said three thousand years ago, so still it must be said <break time="200ms"/><prosody rate="0.85">the judgments of the Lord are true and righteous altogether.</prosody></p>
<p><prosody rate="0.88">With malice toward none, <break time="200ms"/>with charity for all, <break time="200ms"/>with firmness in the right as God gives us to see the right, <break time="300ms"/>let us strive on to finish the work we are in, <break time="200ms"/>to bind up the nation's wounds, <break time="200ms"/>to care for him who shall have borne the battle and for his widow and his orphan, <break time="300ms"/>to do all which may achieve and cherish a just and lasting peace among ourselves and with all nations.</prosody></p>
</speak>`,
  },
  {
    name: "To be, or not to be",
    plain: `To be, or not to be, that is the question:
Whether 'tis nobler in the mind to suffer
The slings and arrows of outrageous fortune,
Or to take arms against a sea of troubles,
And by opposing end them.

To die, to sleep;
No more; and by a sleep to say we end
The heart-ache and the thousand natural shocks
That flesh is heir to: 'tis a consummation
Devoutly to be wished.

To die, to sleep;
To sleep, perchance to dream: ay, there's the rub;
For in that sleep of death what dreams may come
When we have shuffled off this mortal coil,
Must give us pause: there's the respect
That makes calamity of so long life.

For who would bear the whips and scorns of time,
The oppressor's wrong, the proud man's contumely,
The pangs of despised love, the law's delay,
The insolence of office, and the spurns
That patient merit of the unworthy takes,
When he himself might his quietus make
With a bare bodkin?

Who would fardels bear,
To grunt and sweat under a weary life,
But that the dread of something after death,
The undiscovered country from whose bourn
No traveller returns, puzzles the will,
And makes us rather bear those ills we have
Than fly to others that we know not of?

Thus conscience does make cowards of us all;
And thus the native hue of resolution
Is sicklied o'er with the pale cast of thought,
And enterprises of great pitch and moment
With this regard their currents turn awry,
And lose the name of action.

Soft you now! The fair Ophelia! Nymph, in thy orisons
Be all my sins remembered.`,
    ssml: `<speak>
<p><prosody rate="0.9">To be, <break time="200ms"/>or not to be, <break time="400ms"/>that is the question: <break time="300ms"/>
Whether 'tis nobler in the mind to suffer
The slings and arrows of outrageous fortune, <break time="200ms"/>
Or to take arms against a sea of troubles,
And by opposing end them.</prosody></p>
<p><prosody rate="0.85" volume="soft" pitch="-1st">To die, <break time="300ms"/>to sleep; <break time="300ms"/>
No more; <break time="200ms"/>and by a sleep to say we end
The heart-ache and the thousand natural shocks
That flesh is heir to: <break time="200ms"/>'tis a consummation
Devoutly to be wished.</prosody></p>
<p><prosody rate="0.85" volume="soft" pitch="-1st">To die, <break time="300ms"/>to sleep; <break time="300ms"/>
To sleep, <break time="200ms"/>perchance to dream:</prosody> <break time="300ms"/><emphasis>ay</emphasis>, there's the rub; <break time="200ms"/>
For in that sleep of death what dreams may come
When we have shuffled off this mortal coil,
Must give us pause: <break time="200ms"/>there's the respect
That makes calamity of so long life.</p>
<p>For who would bear the whips and scorns of time,
The oppressor's wrong, <break time="100ms"/>the proud man's <phoneme alphabet="x-arpabet" ph="K AA1 N T Y UW0 M L IY0">contumely</phoneme>,
The pangs of despised love, <break time="100ms"/>the law's delay,
The insolence of office, and the spurns
That patient merit of the unworthy takes,
When he himself might his <phoneme alphabet="x-arpabet" ph="K W AY0 IY1 T AH0 S">quietus</phoneme> make
With a bare <emphasis>bodkin</emphasis>?</p>
<p>Who would fardels bear,
To grunt and sweat under a weary life,
But that the dread of something after death, <break time="200ms"/>
<prosody rate="0.85">The undiscovered country from whose bourn
No traveller returns,</prosody> <break time="200ms"/>puzzles the will,
And makes us rather bear those ills we have
Than fly to others that we know not of?</p>
<p>Thus conscience does make cowards of us all; <break time="300ms"/>
And thus the native hue of resolution
Is sicklied <phoneme alphabet="x-arpabet" ph="AO1 R">o'er</phoneme> with the pale cast of thought,
And enterprises of great pitch and moment
With this regard their currents turn awry,
<prosody rate="0.85">And lose the name of action.</prosody></p>
<p><prosody volume="soft" rate="0.95">Soft you now! <break time="300ms"/>The fair Ophelia! <break time="400ms"/>Nymph, in thy <phoneme alphabet="x-arpabet" ph="AO1 R IH0 Z AH0 N Z">orisons</phoneme>
Be all my sins remembered.</prosody></p>
</speak>`,
  },
  {
    name: "St Crispin's Day",
    plain: `What's he that wishes so?
My cousin Westmoreland? No, my fair cousin;
If we are marked to die, we are enow
To do our country loss; and if to live,
The fewer men, the greater share of honor.

God's will! I pray thee, wish not one man more.
By Jove, I am not covetous for gold,
Nor care I who doth feed upon my cost;
It yearns me not if men my garments wear;
Such outward things dwell not in my desires.
But if it be a sin to covet honor,
I am the most offending soul alive.

No, faith, my coz, wish not a man from England.
God's peace! I would not lose so great an honor
As one man more, methinks, would share from me
For the best hope I have. O, do not wish one more!

Rather proclaim it, Westmoreland, through my host,
That he which hath no stomach to this fight,
Let him depart; his passport shall be made,
And crowns for convoy put into his purse.
We would not die in that man's company
That fears his fellowship to die with us.

This day is called the feast of Crispian.
He that outlives this day, and comes safe home,
Will stand a-tiptoe when this day is named,
And rouse him at the name of Crispian.

He that shall live this day, and see old age,
Will yearly on the vigil feast his neighbors,
And say, "Tomorrow is Saint Crispian."
Then will he strip his sleeve and show his scars,
And say, "These wounds I had on Crispin's day."

Old men forget; yet all shall be forgot,
But he'll remember, with advantages,
What feats he did that day. Then shall our names,
Familiar in his mouth as household words,
Harry the King, Bedford and Exeter,
Warwick and Talbot, Salisbury and Gloucester,
Be in their flowing cups freshly remembered.

This story shall the good man teach his son;
And Crispin Crispian shall ne'er go by,
From this day to the ending of the world,
But we in it shall be remembered,
We few, we happy few, we band of brothers.

For he today that sheds his blood with me
Shall be my brother; be he ne'er so vile,
This day shall gentle his condition.
And gentlemen in England now abed
Shall think themselves accursed they were not here,
And hold their manhoods cheap whiles any speaks
That fought with us upon Saint Crispin's day.`,
    ssml: `<speak>
<p>What's he that wishes so? <break time="300ms"/>
My cousin Westmoreland? <break time="300ms"/>No, my fair cousin;
If we are marked to die, we are <phoneme alphabet="x-arpabet" ph="IH0 N AW1">enow</phoneme>
To do our country loss; <break time="200ms"/>and if to live,
The fewer men, <break time="150ms"/>the greater share of <emphasis>honor</emphasis>.</p>
<p>God's will! <break time="200ms"/>I pray thee, wish not one man more.
By Jove, I am not covetous for gold,
Nor care I who doth feed upon my cost;
It yearns me not if men my garments wear;
Such outward things dwell not in my desires.
<break time="300ms"/>But if it be a sin to covet honor,
I am the most offending soul alive.</p>
<p>No, faith, my coz, wish not a man from England.
God's peace! I would not lose so great an honor
As one man more, <phoneme alphabet="x-arpabet" ph="M IH0 TH IH1 NG K S">methinks</phoneme>, would share from me
For the best hope I have. <break time="300ms"/><emphasis level="strong">O, do not wish one more!</emphasis></p>
<p>Rather proclaim it, Westmoreland, through my host,
That he which hath no stomach to this fight,
Let him depart; <break time="200ms"/>his passport shall be made,
And crowns for convoy put into his purse.
<prosody pitch="-1st">We would not die in that man's company
That fears his fellowship to die with us.</prosody></p>
<p><prosody rate="0.95">This day is called the feast of Crispian.</prosody> <break time="300ms"/>
He that outlives this day, and comes safe home,
Will stand a-tiptoe when this day is named,
And rouse him at the name of Crispian.</p>
<p>He that shall live this day, and see old age,
Will yearly on the vigil feast his neighbors,
And say, <break time="150ms"/><prosody pitch="+2st">Tomorrow is Saint Crispian.</prosody>
Then will he strip his sleeve and show his scars,
And say, <break time="150ms"/><prosody pitch="+2st">These wounds I had on Crispin's day.</prosody></p>
<p>Old men forget; <break time="200ms"/>yet all shall be forgot,
But he'll remember, with advantages,
What feats he did that day. <break time="300ms"/>Then shall our names,
Familiar in his mouth as household words,
<prosody rate="1.05" pitch="+1st">Harry the King, <break time="100ms"/>Bedford and Exeter,
Warwick and Talbot, <break time="100ms"/>Salisbury and Gloucester,</prosody>
Be in their flowing cups freshly remembered.</p>
<p>This story shall the good man teach his son;
And Crispin Crispian shall ne'er go by,
From this day to the ending of the world,
But we in it shall be remembered, <break time="300ms"/>
<prosody rate="0.85" pitch="+1st" volume="+2dB">We few, <break time="250ms"/>we happy few, <break time="250ms"/>we band of <emphasis>brothers</emphasis>.</prosody></p>
<p>For he today that sheds his blood with me
Shall be my <emphasis>brother</emphasis>; <break time="200ms"/>be he ne'er so vile,
This day shall gentle his condition.
<break time="300ms"/>And gentlemen in England now abed
Shall think themselves accursed they were not here,
<prosody rate="0.9" volume="+2dB">And hold their manhoods cheap whiles any speaks
That fought with us upon Saint Crispin's day.</prosody></p>
</speak>`,
  },
  {
    name: "Friends, Romans, countrymen",
    plain: `Friends, Romans, countrymen, lend me your ears;
I come to bury Caesar, not to praise him.

The evil that men do lives after them;
The good is oft interred with their bones;
So let it be with Caesar.

The noble Brutus
Hath told you Caesar was ambitious.
If it were so, it was a grievous fault,
And grievously hath Caesar answered it.
Here, under leave of Brutus and the rest,
For Brutus is an honorable man;
So are they all, all honorable men,
Come I to speak in Caesar's funeral.

He was my friend, faithful and just to me;
But Brutus says he was ambitious;
And Brutus is an honorable man.

He hath brought many captives home to Rome
Whose ransoms did the general coffers fill.
Did this in Caesar seem ambitious?
When that the poor have cried, Caesar hath wept;
Ambition should be made of sterner stuff.
Yet Brutus says he was ambitious;
And Brutus is an honorable man.

You all did see that on the Lupercal
I thrice presented him a kingly crown,
Which he did thrice refuse. Was this ambition?
Yet Brutus says he was ambitious;
And, sure, he is an honorable man.

I speak not to disprove what Brutus spoke,
But here I am to speak what I do know.
You all did love him once, not without cause;
What cause withholds you then to mourn for him?

O judgment, thou art fled to brutish beasts,
And men have lost their reason! Bear with me.
My heart is in the coffin there with Caesar,
And I must pause till it come back to me.`,
    ssml: `<speak>
<p><prosody volume="+2dB">Friends, <break time="150ms"/>Romans, <break time="150ms"/>countrymen, <break time="200ms"/>lend me your ears;</prosody> <break time="300ms"/>
I come to <emphasis>bury</emphasis> Caesar, <break time="200ms"/>not to <emphasis>praise</emphasis> him.</p>
<p>The evil that men do lives after them;
The good is oft interred with their bones;
<break time="200ms"/>So let it be with Caesar.</p>
<p>The <emphasis>noble</emphasis> Brutus
Hath told you Caesar was ambitious.
If it were so, it was a grievous fault,
And grievously hath Caesar answered it.
Here, under leave of Brutus and the rest, <break time="200ms"/>
<prosody pitch="-1st">For Brutus is an <emphasis>honorable</emphasis> man;
So are they all, all honorable men,</prosody> <break time="200ms"/>
Come I to speak in Caesar's funeral.</p>
<p>He was my friend, faithful and just to me;
<break time="200ms"/>But Brutus says he was ambitious;
<prosody rate="0.9">And Brutus is an <emphasis>honorable</emphasis> man.</prosody></p>
<p>He hath brought many captives home to Rome
Whose ransoms did the general coffers fill.
<prosody pitch="+2st">Did this in Caesar seem ambitious?</prosody> <break time="300ms"/>
When that the poor have cried, Caesar hath wept;
Ambition should be made of sterner stuff.
<break time="200ms"/>Yet Brutus says he was ambitious;
<prosody rate="0.9">And Brutus is an <emphasis>honorable</emphasis> man.</prosody></p>
<p>You all did see that on the Lupercal
I thrice presented him a kingly crown,
Which he did <emphasis>thrice</emphasis> refuse. <break time="300ms"/><prosody pitch="+2st">Was this ambition?</prosody> <break time="400ms"/>
Yet Brutus says he was ambitious;
<prosody rate="0.85">And, <break time="150ms"/>sure, <break time="150ms"/>he is an <emphasis level="strong">honorable</emphasis> man.</prosody></p>
<p>I speak not to disprove what Brutus spoke,
But here I am to speak what I do know.
You all did love him once, not without cause;
What cause withholds you then to mourn for him?</p>
<p>O judgment, <break time="200ms"/>thou art fled to brutish beasts,
And men have lost their reason! <break time="500ms"/>
<prosody rate="0.85" volume="soft" pitch="-1st">Bear with me. <break time="300ms"/>
My heart is in the coffin there with Caesar,
And I must pause till it come back to me.</prosody></p>
</speak>`,
  },
];
