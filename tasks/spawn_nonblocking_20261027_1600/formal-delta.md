# 非阻塞 Spawn（A1s）与保留回复（B）：对 FormularDef 的增量规格

状态：v2（根，2026-10-27）。v1 经 Astra 审（根 log #40），按其必须修正项 M1–M6 改；改动对照见文末。用户已定：B 的目标是模型以后还记得（1a）；A 用 A1s（2）；Close/Next 遇到未结束的子拒绝（3a）；「回给用户的话」按 §D5 的定义（4）。

改动边界：FormularDef（下称 FD）的 token 字母表、文法、suffix-only 归约不变；补充**外部输入的接纳语义**（FD 现在只写了采样周期），改 Spawn 的 μ 的含义、Close 的有效域和 memory 的组成。节号 §D*。

## §D0 一句话

Spawn 在采样后只记下不可变的「出生」；子任务的最终结果之后作为一条带类型的**外部输入**被接纳，和用户消息走同一条路，归入接纳时的光标节点；Close 要求被关节点里每个出生都已有结果被接纳；Close 时被保留的消息（用户消息、子任务结果、回给用户的话）按原顺序进入 memory。

## §D1 消息的类型

FD §0.1 的 message occurrence $m\in\mathcal M$ 加一个由 host 在消息产生时给出、此后不变的类型：

$$
\kappa(m)\in\{\mathsf{user},\ \mathsf{assistant},\ \mathsf{tool},\ \mathsf{arrival},\ \mathsf{other}\}
$$

$\kappa(m)=\mathsf{arrival}$ 时 $m$ 携带结构化内容 $\operatorname{arr}(m)=(x,\ \mathit{outcome},\ \mu_x?,\ \mathit{diag}?)$：

- $x$ 是 producer：产生这个结果的子节点 id；
- $\mathit{outcome}=\mathsf{completed}$ 时 $\mu_x$ 必有，是子节点的 assembled memory；否则 $\mu_x$ 缺省、$\mathit{diag}$ 必有（不伪造 memory）。

类型和结构化内容只来自 host 的 typed 事件，不从渲染文本推断（FD §2.0.7 不变）。

## §D2 Spawn = 出生

FD §2.0.4 表中 Spawn 一行改为：spine.spawn(tasks) 在 PostSampling 发出

$$
a^{\mathrm{post}}_{\mathrm{spawn}}=\prod_{i=0}^{k-1}\mathsf{SpineSpawnNode}(\beta_i)
$$

- $\beta_i=\operatorname{birth}(x_i,d_i)$ 是 typed 语义值：子 id $x_i$（当前光标节点的下一个 child ordinal，按 task order，规则不变）和任务描述 $d_i$。模型看到的是它的文字投影（「在这里发起了任务 $x_i$：…」），投影里不写运行状态。
- 归约：$\mathsf{SpineSpawnNode}(\beta_i)\to\mathsf{SpineTreeNode}(d_i,[],\beta_i)$，产生式不变。
- FD 里「SpineTreeNode 代表已完成的 scope」的说法要改：出生节点只代表**出生记录已归约**，不代表子任务已执行完。子任务是否结束由 $\operatorname{born}\setminus\operatorname{arrived}$ 推导，没有可变的 pending 状态，不存在把 Pending 原地改成 Closed。
- 子任务的执行、调度、取消仍在契约之外。子的初始上下文 $C_{\mathrm{child}}=C^{(t)}_{\mathrm{parent}}\cdot\Delta_{\mathrm{child}}$，$C^{(t)}_{\mathrm{parent}}$ 是出生那次采样的上下文快照，之后不随父变化。

$\operatorname{born}(F)$：$F$ 里（递归含子节点）所有出生的 $x$ 的集合。

## §D3 结果的接纳 = 外部输入

### 外部输入块

FD §2.0.3 只定义了采样周期。补充：第 $t$ 次采样开始之前、上一次 PostSampling 之后被接纳的外部输入消息（用户消息、arrival）组成输入块 $E_t$，归约分两步：

$$
T^{\mathrm{in}}_t=\operatorname{shift\text{-}reduce}\big(T^{\mathrm{post}}_{t-1};\ \widehat{E_t}\big),\qquad
T^{\mathrm{post}}_t=\operatorname{shift\text{-}reduce}\big(T^{\mathrm{in}}_t;\ a^{\mathrm{pre}}_t\cdot\widehat{B_t}\cdot a^{\mathrm{post}}_t\big)
$$

模型在 $\operatorname{backend}(T^{\mathrm{in}}_t)$ 上采样；§D4 的校验也在 $T^{\mathrm{in}}_t$ 上做。这和 core 现行路径一致：preview 把未提交的 source 尾部归约给模型看（planner.rs:104–125），begin_sampling 以已含输入的 source 尾部为 pre_boundary（planner.rs:139–156），reduce 先吃 pre_boundary 之前的 source、再吃采样输出（sampling_delta.rs:95–113）。用户消息本来就这样处理，只是 FD 没写出来。

### 归属

- $\operatorname{owner}(x)$：$x$ 的出生所在节点，由出生结构给出。
- $\operatorname{receiver}(r_x)$：接纳 $r_x$ 时的光标节点，由归约顺序给出。它取**接纳边界上的光标**：不是子进程结束时的光标，也不是下一次采样执行 Close 之后的光标。
- 例：P 下 spawn 了 X，模型在 P 的子节点 Q 里工作。X 的结果在第 $t$ 次采样开始前被接纳 → receiver 是 Q，哪怕第 $t$ 次采样关闭了 Q（结果随 Q 的 memory 上卷到 P）。结果在第 $t$ 次采样（关闭 Q）进行中到达 → 排队，进 $E_{t+1}$，receiver 是 P。第 $t$ 次采样是 Open R → receiver 是 R。
- 两者都可推导，不另存；所有权只看出生，不从「$r_x$ 在谁的 memory 里」反推。

### 接纳条件（缺一不可，作为一次不可分的接纳）

1. producer $x$ 在同一 session/branch/epoch 里有已提交的出生，且 $x\notin\operatorname{arrived}$。
2. $r_x$ 是恢复策略最终接受的结果，不是某次 attempt 的结束：Retry/Continue 还没定，就不产生 arrival。
3. 子任务的资源已释放：自有 attempt 已终结，或取消已完成。只凭一条 arrival 标签不能说明进程停了，这一条由 host 保证。
4. 校验、身份、内容、在 source 里的位置一起生效：要么整条进入 source，要么没进。
5. 去重在进入 source 之前做：同一 $x$ 重复投递、内容相同则只保留一条；内容不同报错。进入 source 的流里同一 $x$ 至多一条。

### 权威与恢复

- 子任务的终态由子任务自己的持久记录给出（子 session 封口的结果）；「已接纳」由父 source 里那条 arrival 给出。两者都不另建可变的状态树，$\operatorname{arrived}$ 从父 source 推导。
- 终态已持久化、arrival 还没进父 source（投递丢失、父采样失败、崩溃）：重启或下一个边界时按 $x$ 重新投递，不重跑子任务。
- 有出生、没有终态、子进程也不在了：标为待恢复决定（沿用原设计：用户或模型选 Retry/Continue/放弃，放弃产生 aborted arrival）。

### 逐子接纳

每个子任务结束就各自产生一条 arrival，不等同批的其他子。一批 spawn 只是同一次采样里的几个出生，没有批级状态。

## §D4 Close 的有效域（FD §2.0.6 在原有有效域上加一条）

当前光标节点 $N=\mathsf{Open}(d)\ F$。在原有有效域（例如 root 不能 Close）之外，Close($\mu$) 与 Next 的 close 部分还要求在 $T^{\mathrm{in}}_t$ 上

$$
\operatorname{born}(F)\subseteq\operatorname{arrived}(F)
$$

其中 $\operatorname{arrived}(F)$ 是 $F$ 里（递归含子节点、含已关子节点）所有被接纳 arrival 的 producer 集合。不满足时 host 报错并列出 $\operatorname{born}(F)\setminus\operatorname{arrived}(F)$，不发生迁移，不降级为别的操作。

- 判定只用 formal 状态，不另建 pending 登记表；前提是出生 id 与 arrival 的 producer 是结构化数据，已关子节点保留这两个集合。实现位置：reduce 吃完 pre_boundary 之前的 source、应用控制事实之前；工具层的提前拒绝必须基于同一个输入版本（含本轮刚 preview 给模型的 arrival），不能只查已提交的 projection。
- 推论 I1：$x$ 出生于 $P$，则 $P$ 关闭前 $r_x$ 已落在 $P$ 的子树内；祖先同理。
- Compact 同样要求当前 epoch 里 $\operatorname{born}\subseteq\operatorname{arrived}$（join 屏障）。
- Stop 取消自有子任务；取消完成后产生 aborted arrival。父节点要在这条 arrival 被接纳、并被后续某次采样看到之后才能关闭；Stop 不自动唤醒父 agent。

## §D5 memory 的组成

保留谓词：

$$
\operatorname{kept}(m)\iff \kappa(m)\in\{\mathsf{user},\mathsf{arrival}\}\ \lor\ \operatorname{reply}(m)
$$

$$
\operatorname{reply}(m)\iff \kappa(m)=\mathsf{assistant}\land \mathit{stop}(m)=\mathsf{stop}\land m\text{ 不含工具调用}\land m\text{ 有非空文本块}
$$

保留的是投影 $\operatorname{keep}(m)$：user、arrival 原样；reply 只取文本块（不含思考内容和签名）。

记号：$\mu$ **只指本节点模型写的 memory**；$h(\cdot)$ 是 assembled memory。FD §2.0.1 的 $h$ 第三行改为

$$
h(\mathsf{SpineTreeNode}(d,F,\mu))=\Big(\prod_{v\in F}\operatorname{ret}(v)\Big)\cdot\mu,\qquad
\operatorname{ret}(v)=\begin{cases}
\operatorname{keep}(m), & v=\mathsf{Message}(m)\land\operatorname{kept}(m)\\
[\,], & v=\mathsf{Message}(m)\land\lnot\operatorname{kept}(m)\\
h(v), & v=\mathsf{SpineTreeNode}(\ldots)
\end{cases}
$$

出生节点 $F=[\,]$、$\mu=\beta$，所以 $h=\beta$，父的 memory 记得它发起过 $x$。这和 reducer.rs:402–435 的 assemble_memory 同形：按 entries 顺序保留 user、子节点复制它**已 assembled 的** memory、最后追加本节点的 summary。实现里的 `node.memory` 就是 $h$，不能再把它当 $\mu$ 递归展开一次。

## §D6 不变式

- I1 所有权：§D4 推论。
- I2 位置：$x$ 的 id 和在 owner 里的位置在出生时确定，之后不变；receiver 由归约顺序确定。
- I3 回放：输入全是 source 里的 message/annotation，同一 source 得到同一状态。
- I4 一次：每条被保留的 occurrence 在任何可见投影里至多出现一次；不保留的出现零次。证明：可见投影只展开一层 frontier，已关节点不展开 body；Close 把原 frontier 里各项的保留序列搬进唯一的替代项，不复制 occurrence；按 Close 次数归纳。前提：每个 $x$ 一条 canonical arrival；keep 和上卷保留身份；adapter 不再额外投影一份结果正文。这只保证 occurrence 不重复，不保证模型写的 summary 不复述结果。
- I5 单光标、工具配对：arrival 只在消息边界进入 $E_t$，不插进工具请求与结果之间。
- I6 输入版本固定：采样期间到达的结果排队，进下一个 $E$。
- I7 隔离：arrival 只投递给出生所在的 session/branch/epoch。
- I8 出生快照：§D2。

## §D7 与现行实现的差

- core：
  - Spawn 事实不再携带终态结果，只带 tasks 和 id；SpawnEvidence 变成 typed 出生记录。
  - 新增 arrival 输入类型（含 producer），节点状态保留 born/arrived 集合（已关节点也保留）。
  - Close/Next 在 $T^{\mathrm{in}}$ 上加 §D4 校验；Compact 同样。
  - kept 加 arrival 和 reply；reply 要求 sampling source 保留到消息粒度（现在 sampling_delta 把采样输出聚成 span，要能认出最后一条 stop 且无工具调用的 assistant 消息）。
  - SpawnResult 非 completed 时不再要求 memory，必须带 diag。
- Pi：
  - spine_spawn 立即返回稳定 handle（子 id）和 accepted 回执；本轮 turn_end 持久化并安装出生；之后才启动真实子进程。工具不能等待本轮 commit，否则 turn_end 等工具、工具等 turn_end，形成循环等待。
  - 结果经 sendMessage（custom，steer；idle 时 triggerTurn）投递，details 带 typed arrival。sendMessage 是 fire-and-forget（agent-session.js:2703–2710），不等于已持久化：去重和重投按 §D3「权威与恢复」做。
  - custom 消息现在一律映射为 contextual_user（messages.ts:379–397），Close 时不保留；arrival 要单独映射为 typed 类型。
  - Retry 用出生快照；Stop 取消自有子并产生 aborted arrival；Compact 前等待；重启时按 §D3 恢复。
- DSH：arrival 作为带 producer 的输入消息进入，同一规则；落地方式看 tuy3fyg3 的 PoC。

## §D8 测试场景（最少）

1. arrival 在采样前被接纳，随后 Close：结果留在被关节点的 memory 里。
2. arrival 在 Close Q 的采样中到达：之后归 P。
3. arrival 在 Open R 的采样中到达：之后归 R。
4. 终态已持久化、arrival 接纳前崩溃：恢复后不重跑、不重复。
5. 多层 Close 后出生与 arrival 都保留，每条 occurrence 只投影一次。
6. Close 时有未接纳的出生：拒绝并列出；arrival 被接纳后 Close 成功。
7. reply 保留：stop 且无工具调用的 assistant 文本跨 Close/Next 保留；带工具调用的过程文字、length 截断、思考内容不保留。

## v1 → v2 改动

- M1：§D3 改为外部输入块 $E_t$ 先归约，receiver 取接纳边界上的光标（v1 把 arrival 放进下一周期的 B，与 core 路径不符，且和 §D4 自相矛盾）；补上 Open 的情况。
- M2：补接纳条件、权威与恢复、去重位置。
- M3：定义 producer/owner/receiver；改 FD 对出生节点的解释；资源释放由 host 保证。
- M4：§D4 写成「在原有有效域上加一条」；写明判定的前提和实现位置；改正 Stop 的措辞。
- M5：区分 $\mu$ 与 $h$；改 I4 的措辞和前提。
- M6：spine_spawn 返回 accepted 回执，出生在本轮 turn_end 提交后才启动子进程。
- 采纳建议：出生为 typed 语义值；逐子接纳；§D8 测试场景。
